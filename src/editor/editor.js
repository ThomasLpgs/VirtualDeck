/* global PAGE_SIZE, api, t, I18N, loadI18n, createKey, createGlyph, renderDeckHeader, markKeys, countVerticalIssues, hasRunningTimer
   -- api comes from preload.js, t/I18N/loadI18n from shared/i18n.js, the rest from shared/keys.js */
const $ = (id) => document.getElementById(id);

const SAVE_DEBOUNCE_MS = 400;
const MAX_ICON_RESULTS = 120;
const DEFAULT_COLOR = '#8b8d98';

const PALETTE = [
  ['grey', '#8b8d98'],
  ['red', '#f2555a'],
  ['orange', '#f5843b'],
  ['amber', '#f2b33d'],
  ['green', '#3fcf8e'],
  ['teal', '#2bc4c4'],
  ['blue', '#4c8dff'],
  ['indigo', '#7c8cff'],
  ['violet', '#b06cff'],
  ['pink', '#f062a8'],
];

// Shown before the user searches: the icons a streamer reaches for first.
const SUGGESTED_ICONS = [
  'clapperboard', 'video', 'video-off', 'camera', 'camera-off', 'mic', 'mic-off', 'volume-2',
  'volume-x', 'music', 'headphones', 'radio', 'circle-dot', 'circle-stop', 'play', 'pause',
  'skip-forward', 'monitor', 'monitor-play', 'tv', 'cast', 'layers', 'image', 'film',
  'sparkles', 'party-popper', 'zap', 'flame', 'heart', 'star', 'bell', 'megaphone',
  'message-square', 'messages-square', 'users', 'thumbs-up', 'smile', 'laugh', 'hand', 'gift',
  'trophy', 'crown', 'rocket', 'swords', 'skull', 'ghost', 'gamepad-2', 'timer',
  'coffee', 'sun', 'moon', 'eye', 'eye-off', 'globe', 'external-link', 'house',
];

// Action type ids keep their historical "obs-" prefix; they work with every streaming software.
const ACTIONS = [
  { type: 'none', icon: 'ban', defaults: {} },
  { type: 'obs-scene', icon: 'clapperboard', defaults: { scene: '' } },
  { type: 'obs-source', icon: 'layers', defaults: { scene: '', source: '', mode: 'flash', duration: 5 } },
  { type: 'obs-mute', icon: 'mic-off', defaults: { input: '', mode: 'toggle' } },
  { type: 'obs-replay', icon: 'film', defaults: {} },
  { type: 'obs-record', icon: 'circle-dot', defaults: {} },
  { type: 'obs-stream', icon: 'radio', defaults: {} },
  { type: 'sound', icon: 'volume-2', defaults: { file: '', volume: 1 } },
  { type: 'open', icon: 'external-link', defaults: { target: '' } },
  { type: 'page', icon: 'files', defaults: { page: 'next' } },
  { type: 'multi', icon: 'list-ordered', defaults: { steps: [] } },
];

// What a step of a multi-action can do: any action but "none" and another multi-action.
const STEP_ACTIONS = ACTIONS.filter((action) => !['none', 'multi'].includes(action.type));

const SOURCE_MODES = ['flash', 'toggle', 'show', 'hide'];
// Canvases a stream / record / clip key can act on (action.target).
const OUTPUT_TARGETS = ['horizontal', 'vertical', 'both'];
const MUTE_MODES = ['toggle', 'mute', 'unmute'];

// Connection form per streaming software: which config field holds the secret.
const SOFTWARE = {
  obs: { label: 'OBS', secret: 'password', secretLabel: 'conn.password', secretPlaceholder: 'conn.passwordPlaceholder' },
  streamlabs: { label: 'Streamlabs', secret: 'token', secretLabel: 'conn.token', secretPlaceholder: 'conn.tokenPlaceholder' },
};

let config = null;
let selected = 0;
// Page shown in the preview (0-based); `selected` is an index in config.buttons.
let page = 0;
const MAX_PAGES = 10;
const pageStart = () => page * PAGE_SIZE;
const perPage = () => config.grid.cols * config.grid.rows;
let streamState = { status: 'disconnected' };
let icons = { names: [], tags: {} };
let saveTimer = null;
let dragFrom = null;
// Scene / source names fetched from the streaming software, offered as suggestions.
const streamLists = { scenes: [], verticalScenes: [], sources: [], verticalSources: [], inputs: [] };
// A button the main process asked us to select (from the deck) before config finished loading.
let pendingSelect = null;
// Keys whose own hotkey couldn't be registered, as reported by the last save.
let failedKeyHotkeys = [];

api.onEditorSelect((index) => {
  if (!config) {
    pendingSelect = index;
    return;
  }
  showView('buttons');
  select(Math.min(index, config.buttons.length - 1));
});

const current = () => config.buttons[selected];
const fileName = (p) => (p ? p.split(/[\\/]/).pop() : '');
const isStreamAction = (type) => type.startsWith('obs-');
// Whether an action (or one of its steps) needs OBS / Streamlabs.
const usesStream = (action) =>
  isStreamAction(action.type) || (action.steps || []).some((step) => isStreamAction(step.action?.type || ''));
const software = () => SOFTWARE[config.software];

function emptyButton() {
  return {
    id: crypto.randomUUID(),
    label: '',
    symbol: '',
    icon: '',
    image: '',
    imageUrl: '',
    color: DEFAULT_COLOR,
    action: { type: 'none' },
  };
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// ---------- Saving (automatic, like the Elgato software) ----------

function setStatus(text, warn = false) {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('warn', warn);
}

function scheduleSave() {
  setStatus(t('save.saving'));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

// Writes a pending debounced save right away (before export/import reads the config).
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  await save();
}

// Closing the editor (or the reload after a language change) would drop a save still waiting for its debounce.
window.addEventListener('pagehide', () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  api.saveConfig(config);
});

async function save() {
  saveTimer = null;
  const result = await api.saveConfig(config);
  if (!result.ok) {
    setStatus(t('save.error', { error: result.error }), true);
    return;
  }
  failedKeyHotkeys = result.failedKeyHotkeys || [];
  renderKeyHotkeyHint();
  const hint = $('hotkey-hint');
  if (result.hotkeyOk) {
    setStatus(t('save.saved'));
    hint.textContent = t('settings.hotkeyHint');
    hint.classList.remove('warn');
  } else {
    setStatus(t('save.hotkeyUnavailable'), true);
    hint.textContent = t('settings.hotkeyTaken', { hotkey: formatHotkey(config.hotkey).join(' + ') });
    hint.classList.add('warn');
  }
}

// ---------- Tabs ----------

function showView(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  // Survives the page reload that follows a language change.
  sessionStorage.setItem('view', name);
}

// ---------- Preview ----------

function renderPreview() {
  const { cols } = config.grid;
  const preview = $('preview');
  preview.style.gridTemplateColumns = `repeat(${cols}, var(--key-size))`;
  renderPageTabs();
  preview.replaceChildren(
    ...config.buttons.slice(pageStart(), pageStart() + perPage()).map((button, i) => {
      const key = createKey(button, i);
      const index = pageStart() + i;
      key.classList.toggle('selected', index === selected);
      key.draggable = true;
      key.addEventListener('click', () => select(index));
      key.addEventListener('dragstart', () => (dragFrom = index));
      key.addEventListener('dragover', (e) => {
        e.preventDefault();
        key.classList.add('drop-target');
      });
      key.addEventListener('dragleave', () => key.classList.remove('drop-target'));
      key.addEventListener('drop', (e) => {
        e.preventDefault();
        swap(dragFrom, index);
      });
      return key;
    }),
  );
  markLiveScene();
  $('cols-value').value = cols;
  $('rows-value').value = config.grid.rows;
  $('preview-hotkey').textContent = formatHotkey(config.hotkey).join(' + ');
}

// Page tabs above the preview: one per page, "+" to add one, "×" to delete the page shown.
function renderPageTabs() {
  const tabs = [];
  for (let p = 0; p < config.pageCount; p++) {
    const tab = el('button', { type: 'button', className: 'page-tab', textContent: String(p + 1), title: t('page.n', { n: p + 1 }) });
    tab.classList.toggle('selected', p === page);
    tab.addEventListener('click', () => select(p * PAGE_SIZE));
    tabs.push(tab);
  }
  if (config.pageCount < MAX_PAGES) {
    const add = el('button', { type: 'button', className: 'page-tab', title: t('page.add') }, createGlyph('plus'));
    add.addEventListener('click', addPage);
    tabs.push(add);
  }
  if (config.pageCount > 1) {
    const remove = el('button', { type: 'button', className: 'page-tab', title: t('page.remove') }, createGlyph('x'));
    remove.addEventListener('click', removePage);
    tabs.push(remove);
  }
  $('page-tabs').replaceChildren(...tabs);
}

// Pads the buttons so every page but the last is full (see PAGE_SIZE in config.js).
function padPages() {
  while (config.buttons.length < (config.pageCount - 1) * PAGE_SIZE + perPage()) config.buttons.push(emptyButton());
}

function addPage() {
  config.pageCount += 1;
  padPages();
  select((config.pageCount - 1) * PAGE_SIZE);
  scheduleSave();
}

function removePage() {
  if (!window.confirm(t('page.removeConfirm', { n: page + 1 }))) return;
  config.buttons.splice(pageStart(), PAGE_SIZE);
  config.pageCount -= 1;
  padPages();
  select(Math.min(page, config.pageCount - 1) * PAGE_SIZE);
  scheduleSave();
}

function markLiveScene() {
  const buttons = config.buttons.slice(pageStart(), pageStart() + perPage());
  markKeys($('preview').children, buttons, streamState);
  const state = { ...streamState, label: software().label };
  renderDeckHeader($('preview-status'), state, countVerticalIssues(buttons, streamState));
}

function select(index) {
  selected = index;
  page = Math.floor(index / PAGE_SIZE);
  renderPreview();
  renderInspector();
}

function swap(from, to) {
  dragFrom = null;
  if (from === null || from === to) return renderPreview();
  const b = config.buttons;
  [b[from], b[to]] = [b[to], b[from]];
  select(to);
  scheduleSave();
}

function stepGrid(axis, delta) {
  const max = axis === 'cols' ? 8 : 6;
  config.grid[axis] = Math.min(max, Math.max(1, config.grid[axis] + delta));
  padPages();
  if (selected - pageStart() >= perPage()) selected = pageStart() + perPage() - 1;
  renderPreview();
  renderInspector();
  scheduleSave();
}

// ---------- Inspector ----------

function updateButton(patch) {
  Object.assign(current(), patch);
  renderPreview();
  renderHead();
  scheduleSave();
}

function updateAction(patch) {
  Object.assign(current().action, patch);
  renderPreview();
  scheduleSave();
}

function renderHead() {
  const number = t('editor.buttonN', { n: (selected % PAGE_SIZE) + 1 });
  $('button-number').textContent = config.pageCount > 1 ? `${t('page.n', { n: page + 1 })} · ${number}` : number;
  $('button-title').textContent = current().label || t('editor.untitled');
}

function renderInspector() {
  const button = current();
  renderHead();
  $('label').value = button.label;
  $('emoji').value = button.icon;
  $('image-pick').textContent = button.image ? fileName(button.image) : t('common.choose');
  $('image-pick').title = button.image || '';
  $('image-clear').hidden = !button.image;
  renderIconGrid();
  renderSwatches();
  renderActionTiles();
  renderActionFields();
}

function renderIconGrid() {
  const query = $('icon-search').value.trim().toLowerCase();
  let names;
  if (!query) {
    names = SUGGESTED_ICONS.filter((n) => icons.names.includes(n));
  } else {
    names = icons.names
      .filter((n) => n.includes(query) || icons.tags[n]?.some((tag) => tag.includes(query)))
      .slice(0, MAX_ICON_RESULTS);
  }

  const cells = names.map((name) => {
    const cell = el('button', { type: 'button', className: 'icon-cell', title: name }, createGlyph(name));
    cell.dataset.name = name;
    cell.setAttribute('role', 'option');
    cell.classList.toggle('selected', current().symbol === name);
    cell.addEventListener('click', () => {
      const same = current().symbol === name;
      updateButton({ symbol: same ? '' : name, icon: same ? current().icon : '' });
      $('emoji').value = current().icon;
      refreshIconSelection();
    });
    return cell;
  });
  if (!cells.length) cells.push(el('p', { className: 'icon-empty', textContent: t('editor.noIcon') }));
  $('icon-grid').replaceChildren(...cells);
}

function refreshIconSelection() {
  for (const cell of $('icon-grid').querySelectorAll('.icon-cell')) {
    cell.classList.toggle('selected', cell.dataset.name === current().symbol);
  }
}

function renderSwatches() {
  const color = current().color.toLowerCase();
  const swatches = PALETTE.map(([name, value]) => {
    const swatch = el('button', { type: 'button', className: 'swatch', title: t(`color.${name}`) });
    swatch.style.setProperty('--swatch', value);
    swatch.classList.toggle('selected', value === color);
    swatch.addEventListener('click', () => {
      updateButton({ color: value });
      renderSwatches();
    });
    return swatch;
  });

  const isCustom = !PALETTE.some(([, value]) => value === color);
  const picker = el('input', { type: 'color', value: color, title: t('color.custom') });
  const custom = el('label', { className: 'swatch custom', title: t('color.custom') }, picker);
  if (isCustom) {
    custom.classList.add('selected');
    custom.style.setProperty('--swatch', color);
  }
  picker.addEventListener('input', () => updateButton({ color: picker.value }));
  picker.addEventListener('change', renderSwatches);
  $('swatches').replaceChildren(...swatches, custom);
}

function renderActionTiles() {
  const type = current().action.type;
  $('action-tiles').replaceChildren(
    ...ACTIONS.map((action) => {
      const tile = el(
        'button',
        { type: 'button', className: 'action-tile' },
        createGlyph(action.icon),
        el('span', { textContent: t(`action.${action.type}`) }),
      );
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(action.type === type));
      tile.classList.toggle('selected', action.type === type);
      tile.addEventListener('click', () => {
        if (current().action.type === action.type) return;
        current().action = { type: action.type, ...structuredClone(action.defaults) };
        renderActionTiles();
        renderActionFields();
        renderPreview();
        scheduleSave();
      });
      return tile;
    }),
  );
}

// ---------- Form helpers ----------

function field(labelText, control, hintText) {
  const wrap = el('div', { className: 'field' }, el('label', { textContent: labelText }), control);
  if (hintText) wrap.append(el('p', { className: 'muted', textContent: hintText }));
  return wrap;
}

function textInput(value, onInput, { placeholder = '', options } = {}) {
  const input = el('input', { value: value || '', placeholder, spellcheck: false });
  input.addEventListener('input', () => onInput(input.value));
  return options ? combo(input, options, onInput) : input;
}

// Themed replacement for <datalist>, whose native popup is white and cannot be styled.
// Free typing stays allowed: suggestions only filter as you type.
function combo(input, getOptions, onPick) {
  const menu = el('div', { className: 'combo-menu', hidden: true });
  menu.setAttribute('role', 'listbox');
  const wrap = el('div', { className: 'combo' }, input, createGlyph('chevrons-up-down', 'glyph combo-chevron'), menu);
  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  let active = -1;
  const items = () => [...menu.children];

  function close() {
    menu.hidden = true;
    active = -1;
  }
  function pick(value) {
    input.value = value;
    onPick(value);
    close();
  }
  function open() {
    const all = getOptions();
    const query = input.value.trim().toLowerCase();
    // When the field already holds a valid choice, list everything so the user can switch.
    const shown = all.includes(input.value) ? all : all.filter((o) => o.toLowerCase().includes(query));
    if (!shown.length) return close();
    menu.replaceChildren(
      ...shown.map((option) => {
        const item = el('div', { className: 'combo-option', textContent: option });
        item.setAttribute('role', 'option');
        item.classList.toggle('current', option === input.value);
        // mousedown + preventDefault keeps focus in the input, so blur doesn't close the menu first.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(option);
        });
        return item;
      }),
    );
    active = -1;
    menu.hidden = false;
  }
  function move(delta) {
    const list = items();
    if (!list.length) return;
    active = (active + delta + list.length) % list.length;
    list.forEach((item, i) => item.classList.toggle('active', i === active));
    list[active].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (menu.hidden) open();
      else move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items()[active].textContent);
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      close();
    }
  });
  return wrap;
}

// Themed replacement for <select> (same reason as combo): a button that opens an option list.
function themedSelect(options, value, onChange) {
  const label = el('span', { className: 'select-value' });
  const trigger = el('button', { type: 'button', className: 'select-trigger' }, label, createGlyph('chevrons-up-down', 'glyph combo-chevron'));
  const menu = el('div', { className: 'combo-menu', hidden: true });
  menu.setAttribute('role', 'listbox');
  const wrap = el('div', { className: 'combo select' }, trigger, menu);

  const render = () => {
    label.textContent = options.find(([v]) => v === value)?.[1] ?? '';
    menu.replaceChildren(
      ...options.map(([optValue, text]) => {
        const item = el('div', { className: 'combo-option', textContent: text });
        item.setAttribute('role', 'option');
        item.classList.toggle('current', optValue === value);
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          menu.hidden = true;
          if (optValue === value) return;
          value = optValue;
          render();
          onChange(optValue);
        });
        return item;
      }),
    );
  };
  trigger.addEventListener('click', () => (menu.hidden = !menu.hidden));
  trigger.addEventListener('blur', () => (menu.hidden = true));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.hidden = true;
  });
  render();
  return wrap;
}

function button(text, onClick, className = 'btn') {
  const b = el('button', { type: 'button', className, textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

function inline(...children) {
  return el('div', { className: 'inline' }, ...children);
}

function segmented(options, value, onChange) {
  const wrap = el('div', { className: 'segmented' });
  for (const [optValue, text] of options) {
    const b = button(text, () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === b));
      onChange(optValue);
    }, '');
    b.classList.toggle('selected', optValue === value);
    wrap.append(b);
  }
  return wrap;
}

// ---------- Action fields ----------

// Output picker of stream / record / clip keys: horizontal (OBS), vertical (Aitum) or both.
// Only offered with the plugin (or once a vertical target was chosen, so it can be undone).
function outputField(action, update, rerender) {
  const target = action.target || 'horizontal';
  if (!streamState.verticalAvailable && target === 'horizontal') return [];
  // Says which software is behind each choice; for vertical clips, also that the Backtrack is used.
  let hint = t('field.outputHint', { software: software().label });
  if (!streamState.verticalAvailable) hint = t('field.verticalMissing');
  else if (action.type === 'obs-replay' && target !== 'horizontal') hint += ` ${t('field.replayVerticalHint')}`;
  return [
    field(
      t('field.output'),
      segmented(
        OUTPUT_TARGETS.map((value) => [value, t(`output.${value}`, { software: software().label })]),
        target,
        (value) => {
          update({ target: value });
          rerender();
        },
      ),
      hint,
    ),
  ];
}

// Steps of a multi-action: each one is a regular action, run in order after an optional wait.
function renderSteps(container, action, update, rerender) {
  const steps = action.steps || (action.steps = []);
  // Saves, and redraws the list (order, count or a step's type changed).
  const changed = () => {
    update({});
    rerender();
  };
  steps.forEach((step, i) => {
    const typePicker = themedSelect(
      STEP_ACTIONS.map((a) => [a.type, t(`action.${a.type}`)]),
      step.action.type,
      (type) => {
        step.action = { type, ...structuredClone(ACTIONS.find((a) => a.type === type).defaults) };
        changed();
      },
    );
    const move = (delta) => {
      [steps[i], steps[i + delta]] = [steps[i + delta], steps[i]];
      changed();
    };
    const tools = el(
      'div',
      { className: 'multi-step-tools' },
      iconButton('chevron-up', t('multi.moveUp'), () => move(-1), i === 0),
      iconButton('chevron-down', t('multi.moveDown'), () => move(1), i === steps.length - 1),
      iconButton('trash-2', t('common.remove'), () => {
        steps.splice(i, 1);
        changed();
      }),
    );

    const delay = el('input', { type: 'number', min: 0, max: 600, step: 0.5, value: step.delay ?? 0 });
    delay.addEventListener('input', () => {
      step.delay = Math.max(0, Number(delay.value) || 0);
      update({});
    });

    const body = el('div', { className: 'multi-step-body' });
    const stepUpdate = (patch) => {
      Object.assign(step.action, patch);
      update({});
    };
    fillActionFields(body, step.action, stepUpdate, rerender);

    container.append(
      el(
        'div',
        { className: 'multi-step' },
        el('div', { className: 'multi-step-head' }, el('span', { className: 'multi-step-number', textContent: String(i + 1) }), typePicker, tools),
        field(t('field.stepDelay'), delay),
        body,
      ),
    );
  });
  container.append(
    button(
      t('multi.addStep'),
      () => {
        steps.push({ delay: 0, action: { type: 'obs-scene', scene: '' } });
        changed();
      },
      'btn add-step',
    ),
  );
}

function iconButton(icon, title, onClick, disabled = false) {
  const b = el('button', { type: 'button', className: 'multi-step-btn', title, disabled }, createGlyph(icon));
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function offlineCallout() {
  return el(
    'div',
    { className: 'callout' },
    createGlyph('plug-zap'),
    el('span', { textContent: t('callout.offline', { software: software().label }) }),
    button(t('callout.openGuide'), () => showView('connection')),
  );
}

function renderActionFields() {
  const action = current().action;
  const container = $('action-fields');
  container.replaceChildren();

  if (usesStream(action) && streamState.status !== 'connected') container.append(offlineCallout());
  fillActionFields(container, action, updateAction, renderActionFields);

  if (action.type !== 'none') {
    container.append(keyHotkeyField());
    renderKeyHotkeyHint();
  }
}

// Fields of one action. update(patch) changes it and saves; rerender() redraws the fields after a
// change that alters them. Used for a key's action and for each step of a multi-action.
function fillActionFields(container, action, update, rerender) {
  switch (action.type) {
    case 'obs-scene': {
      // The vertical field only exists with OBS + Aitum Vertical. It also stays visible while it
      // holds a value, so a vertical scene set earlier can still be seen and cleared.
      const showVertical = streamState.verticalAvailable || Boolean(action.verticalScene);
      container.append(
        field(
          t(showVertical ? 'field.horizontalScene' : 'field.scene'),
          textInput(action.scene, (scene) => update({ scene }), {
            options: () => streamLists.scenes,
            placeholder: t(showVertical ? 'field.horizontalPlaceholder' : 'field.scenePlaceholder'),
          }),
        ),
      );
      if (showVertical) {
        container.append(
          field(
            t('field.verticalScene'),
            textInput(action.verticalScene, (verticalScene) => update({ verticalScene }), {
              options: () => streamLists.verticalScenes,
              placeholder: t('field.verticalPlaceholder'),
            }),
            streamState.verticalAvailable ? '' : t('field.verticalMissing'),
          ),
        );
      }
      container.append(el('p', { className: 'muted', textContent: t('field.sceneHint') }));
      break;
    }

    case 'obs-source': {
      // Same idea as scene keys: with Aitum Vertical, a horizontal and a vertical pair, each one
      // acting only when its source is filled. Kept visible while a vertical value is set.
      const showVertical = streamState.verticalAvailable || Boolean(action.verticalScene || action.verticalSource);
      const sceneInput = textInput(
        action.scene,
        (scene) => {
          update({ scene });
          refreshSources(scene);
        },
        { options: () => streamLists.scenes, placeholder: t('field.currentScenePlaceholder') },
      );
      const sourceInput = textInput(action.source, (source) => update({ source }), {
        options: () => streamLists.sources,
        placeholder: t(showVertical ? 'field.horizontalSourcePlaceholder' : 'field.sourcePlaceholder'),
      });
      container.append(
        field(t(showVertical ? 'field.horizontalScene' : 'field.scene'), sceneInput),
        field(t(showVertical ? 'field.horizontalSource' : 'field.source'), sourceInput),
      );

      if (showVertical) {
        const verticalSceneInput = textInput(
          action.verticalScene,
          (verticalScene) => {
            update({ verticalScene });
            refreshVerticalSources(verticalScene);
          },
          { options: () => streamLists.verticalScenes, placeholder: t('field.currentVerticalScenePlaceholder') },
        );
        const verticalSourceInput = textInput(action.verticalSource, (verticalSource) => update({ verticalSource }), {
          options: () => streamLists.verticalSources,
          placeholder: t('field.verticalSourcePlaceholder'),
        });
        container.append(
          field(t('field.verticalScene'), verticalSceneInput),
          field(
            t('field.verticalSource'),
            verticalSourceInput,
            t(streamState.verticalAvailable ? 'field.verticalSourcesHint' : 'field.verticalMissing'),
          ),
        );
        refreshVerticalSources(action.verticalScene);
      }

      const duration = el('input', { type: 'number', min: 0.5, max: 600, step: 0.5, value: action.duration ?? 5 });
      duration.addEventListener('input', () => update({ duration: Number(duration.value) || 5 }));
      const durationField = field(t('field.duration'), duration, t('field.durationHint'));
      durationField.hidden = action.mode !== 'flash';

      container.append(
        field(
          t('field.behavior'),
          segmented(
            SOURCE_MODES.map((mode) => [mode, t(`mode.${mode}`)]),
            action.mode || 'toggle',
            (mode) => {
              update({ mode });
              durationField.hidden = mode !== 'flash';
            },
          ),
        ),
        durationField,
      );
      refreshSources(action.scene);
      break;
    }

    case 'obs-mute':
      container.append(
        field(
          t('field.input'),
          textInput(action.input, (input) => update({ input }), {
            options: () => streamLists.inputs,
            placeholder: t('field.inputPlaceholder'),
          }),
          t('field.muteHint'),
        ),
        field(
          t('field.behavior'),
          segmented(
            MUTE_MODES.map((mode) => [mode, t(`muteMode.${mode}`)]),
            action.mode || 'toggle',
            (mode) => update({ mode }),
          ),
        ),
      );
      // An input may have been added in OBS since the editor opened.
      refreshInputs();
      break;

    case 'obs-replay':
    case 'obs-record':
    case 'obs-stream':
      container.append(
        el('p', { className: 'muted', textContent: t(`action.${action.type}.hint`, { software: software().label }) }),
        ...outputField(action, update, rerender),
      );
      break;

    case 'sound': {
      const name = el('span', { className: 'file-name', textContent: fileName(action.file) || t('field.noFile') });
      const volume = el('input', { type: 'range', min: 0, max: 100, value: Math.round((action.volume ?? 1) * 100) });
      const volumeValue = el('span', { className: 'range-value', textContent: `${volume.value} %` });
      volume.addEventListener('input', () => {
        volumeValue.textContent = `${volume.value} %`;
        update({ volume: Number(volume.value) / 100 });
      });
      container.append(
        field(
          t('field.soundFile'),
          inline(
            name,
            button(t('common.choose'), async () => {
              const picked = await api.pickFile('sound');
              if (!picked) return;
              name.textContent = fileName(picked.path);
              update({ file: picked.path });
            }),
          ),
          t('field.soundHint'),
        ),
        field(t('field.volume'), inline(volume, volumeValue)),
      );
      break;
    }

    case 'open': {
      const target = textInput(action.target, (value) => update({ target: value }), {
        placeholder: t('field.targetPlaceholder'),
      });
      container.append(
        field(
          t('field.target'),
          inline(
            target,
            button(t('common.browse'), async () => {
              const picked = await api.pickFile('program');
              if (!picked) return;
              target.value = picked.path;
              update({ target: picked.path });
            }),
          ),
          t('field.targetHint'),
        ),
      );
      break;
    }

    case 'page': {
      const pages = Array.from({ length: config.pageCount }, (_, p) => [String(p + 1), t('page.n', { n: p + 1 })]);
      container.append(
        el('p', { className: 'muted', textContent: t('action.page.hint') }),
        field(
          t('field.page'),
          themedSelect(
            [['next', t('page.next')], ['prev', t('page.prev')], ...pages],
            String(action.page || 'next'),
            (value) => update({ page: value }),
          ),
        ),
      );
      break;
    }

    case 'multi':
      container.append(el('p', { className: 'muted', textContent: t('action.multi.hint') }));
      renderSteps(container, action, update, rerender);
      break;

    default:
      break;
  }
}
async function refreshScenes() {
  [streamLists.scenes, streamLists.verticalScenes, streamLists.inputs] = await Promise.all([
    api.streamScenes(),
    api.streamVerticalScenes(),
    api.streamInputs(),
  ]);
}

async function refreshInputs() {
  streamLists.inputs = await api.streamInputs();
}

async function refreshSources(scene) {
  streamLists.sources = await api.streamSources(scene, false);
}

async function refreshVerticalSources(scene) {
  streamLists.verticalSources = await api.streamSources(scene, true);
}

// ---------- Hotkey ----------

const KEY_NAMES = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Pause: 'Pause',
  ScrollLock: 'Scrolllock',
};
const ARROWS = { Up: '↑', Down: '↓', Left: '←', Right: '→' };

function keyFromEvent(e) {
  let m;
  // Use the produced letter, not the physical key, so AZERTY layouts register what the user sees.
  if (/^Key[A-Z]$/.test(e.code)) return /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.code.slice(3);
  if ((m = e.code.match(/^Digit(\d)$/))) return m[1];
  if ((m = e.code.match(/^Numpad(\d)$/))) return `num${m[1]}`;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  return KEY_NAMES[e.code] || null;
}

function acceleratorFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  // A lone letter would fire while typing anywhere; only function keys may stand alone.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}

// Accelerator parts as shown on a keyboard of the current language ("Maj", "Strg"…).
function formatHotkey(acc) {
  if (!acc) return [t('common.none')];
  return acc.split('+').map((part) => ARROWS[part] || (I18N.strings[`key.${part}`] ? t(`key.${part}`) : part));
}

// Fills a .hotkey element with the keys of an accelerator ("Ctrl + Maj + Espace").
function renderAccelerator(target, accelerator) {
  const nodes = [];
  formatHotkey(accelerator).forEach((part, i) => {
    if (i) nodes.push(el('span', { className: 'plus', textContent: '+' }));
    nodes.push(el('kbd', { textContent: part }));
  });
  target.replaceChildren(...nodes);
}

function renderHotkey() {
  renderAccelerator($('hotkey'), config.hotkey);
}

// Makes a .hotkey button record the next key combination. onPick(accelerator) gets the result;
// the global hotkeys are paused meanwhile so the combination reaches the page.
function captureHotkey(target, render, onPick) {
  let capturing = false;
  const stop = () => {
    if (!capturing) return;
    capturing = false;
    target.classList.remove('capturing');
    render();
    api.pauseHotkey(false);
  };
  target.addEventListener('click', () => {
    if (capturing) return;
    capturing = true;
    api.pauseHotkey(true);
    target.classList.add('capturing');
    target.textContent = t('settings.hotkeyCapture');
  });
  target.addEventListener('blur', stop);
  target.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') return stop();
    const acc = acceleratorFromEvent(e);
    if (!acc) return;
    onPick(acc);
    stop();
  });
}

// Hotkey of the selected key: runs it from anywhere, without opening the deck.
function keyHotkeyField() {
  const key = current();
  const capture = el('button', { type: 'button', className: 'hotkey' });
  const render = () => renderAccelerator(capture, key.hotkey);
  render();
  captureHotkey(capture, render, (acc) => {
    key.hotkey = acc;
    clear.hidden = false;
    scheduleSave();
  });
  const clear = button(t('common.remove'), () => {
    key.hotkey = '';
    clear.hidden = true;
    render();
    scheduleSave();
  });
  clear.hidden = !key.hotkey;
  const wrap = field(t('field.keyHotkey'), inline(capture, clear), ' ');
  wrap.lastChild.id = 'key-hotkey-hint';
  return wrap;
}

function renderKeyHotkeyHint() {
  const hint = $('key-hotkey-hint');
  if (!hint) return;
  const taken = Boolean(current().hotkey) && failedKeyHotkeys.includes(selected);
  hint.textContent = t(taken ? 'field.keyHotkeyTaken' : 'field.keyHotkeyHint');
  hint.classList.toggle('warn', taken);
}

function setupHotkeyField() {
  captureHotkey($('hotkey'), renderHotkey, (acc) => {
    config.hotkey = acc;
    renderPreview();
    scheduleSave();
  });
}

// ---------- Connection ----------

function connectionError(state) {
  const { label, secret } = software();
  if (state.authFailed) {
    const missing = !config[config.software][secret];
    return t(`conn.error.auth.${config.software}.${missing ? 'missing' : 'wrong'}`, { software: label });
  }
  return t(`conn.error.unreachable.${config.software}`, { software: label });
}

function renderConnectionForm() {
  const settings = config[config.software];
  const { secret, secretLabel, secretPlaceholder } = software();
  document.querySelectorAll('#software-switch button').forEach((b) => {
    const isCurrent = b.dataset.software === config.software;
    b.classList.toggle('selected', isCurrent);
    b.setAttribute('aria-checked', String(isCurrent));
  });
  document.querySelectorAll('[data-guide]').forEach((g) => (g.hidden = g.dataset.guide !== config.software));
  $('conn-url').value = settings.url;
  $('conn-secret-label').textContent = t(secretLabel);
  $('conn-secret').placeholder = t(secretPlaceholder);
  $('conn-secret').value = settings[secret];
}

function renderStreamState() {
  const { status } = streamState;
  const label = software().label;

  $('stream-pill').className = `pill ${status}`;
  $('stream-pill-text').textContent = t(`status.${status}`, { software: label });

  $('conn-big-status').className = `big-status ${status}`;
  $('conn-big-text').textContent = t(`conn.big.${status}`, { software: label });

  const detail = $('conn-detail');
  detail.classList.remove('error');
  if (status === 'connected') {
    detail.textContent = t('conn.liveScene', { scene: streamState.currentScene || '—' });
  } else if (status === 'disconnected' && streamState.error) {
    detail.textContent = connectionError(streamState);
    detail.classList.add('error');
  } else {
    detail.textContent = t('conn.followSteps');
  }

  if (config) markLiveScene();
}

function setSoftware(name) {
  if (config.software === name) return;
  config.software = name;
  streamLists.scenes = [];
  streamLists.verticalScenes = [];
  streamLists.sources = [];
  streamLists.verticalSources = [];
  streamLists.inputs = [];
  renderConnectionForm();
  renderStreamState();
  renderActionFields();
  scheduleSave();
}

// ---------- Backup ----------

function showBackupStatus(text, warn = false) {
  const status = $('backup-status');
  status.textContent = text;
  status.classList.toggle('warn', warn);
  status.hidden = false;
}

async function exportConfig() {
  await flushSave();
  const result = await api.exportConfig();
  if (!result) return;
  if (!result.ok) return showBackupStatus(t('backup.exportFailed', { error: result.error }), true);
  const skipped = result.missing.length
    ? ` ${t('backup.exportMissing', { count: result.missing.length, files: result.missing.map(fileName).join(', ') })}`
    : '';
  showBackupStatus(t('backup.exported', { file: fileName(result.path) }) + skipped, Boolean(skipped));
}

async function importConfig() {
  await flushSave();
  const result = await api.importConfig();
  if (!result) return;
  if (!result.ok) return showBackupStatus(t('backup.importFailed', { error: result.error }), true);
  config = result.config;
  selected = 0;
  renderSettings();
  renderPreview();
  renderInspector();
  setStatus(t('save.saved'));
  showBackupStatus(
    result.hotkeyOk
      ? t('backup.imported', { count: result.buttonCount })
      : t('backup.importedHotkeyTaken', { hotkey: formatHotkey(config.hotkey).join(' + ') }),
    !result.hotkeyOk,
  );
}

// ---------- Updates ----------

function renderUpdate(update) {
  const pill = $('update-pill');
  pill.hidden = !update;
  if (!update) return;
  $('update-pill-text').textContent = t('update.pill', { version: update.version });
  pill.title = t('update.pillTitle');
}

// ---------- Wiring ----------

function bindStaticFields() {
  $('brand-glyph').replaceWith(createGlyph('layout-grid'));
  $('search-glyph').replaceWith(createGlyph('search'));
  $('clear-button').append(createGlyph('trash-2'));

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  $('stream-pill').addEventListener('click', () => showView('connection'));
  $('update-glyph').replaceWith(createGlyph('download'));
  $('update-pill').addEventListener('click', () => api.openUpdate());

  document.querySelectorAll('.stepper').forEach((stepper) => {
    stepper.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => stepGrid(stepper.dataset.axis, Number(b.dataset.step))),
    );
  });

  $('label').addEventListener('input', (e) => updateButton({ label: e.target.value }));
  $('emoji').addEventListener('input', (e) => {
    const icon = e.target.value.trim();
    updateButton({ icon, symbol: icon ? '' : current().symbol });
    refreshIconSelection();
  });
  $('icon-search').addEventListener('input', renderIconGrid);

  $('image-pick').addEventListener('click', async () => {
    const picked = await api.pickFile('image');
    if (!picked) return;
    updateButton({ image: picked.path, imageUrl: picked.url });
    renderInspector();
  });
  $('image-clear').addEventListener('click', () => {
    updateButton({ image: '', imageUrl: '' });
    renderInspector();
  });

  $('clear-button').addEventListener('click', () => {
    config.buttons[selected] = emptyButton();
    renderPreview();
    renderInspector();
    scheduleSave();
  });

  $('close-after').addEventListener('change', (e) => {
    config.closeAfterAction = e.target.checked;
    scheduleSave();
  });
  $('login').addEventListener('change', (e) => {
    config.launchAtLogin = e.target.checked;
    scheduleSave();
  });

  document.querySelectorAll('#software-switch button').forEach((b) =>
    b.addEventListener('click', () => setSoftware(b.dataset.software)),
  );
  $('conn-url').addEventListener('change', (e) => {
    config[config.software].url = e.target.value.trim();
    scheduleSave();
  });
  $('conn-secret').addEventListener('change', (e) => {
    config[config.software][software().secret] = e.target.value;
    scheduleSave();
  });
  $('conn-connect').addEventListener('click', async () => {
    config[config.software].url = $('conn-url').value.trim();
    config[config.software][software().secret] = $('conn-secret').value;
    scheduleSave();
    await flushSave();
    api.streamReconnect();
  });

  const languages = [['auto', t('settings.languageAuto')], ...Object.entries(I18N.languages)];
  $('language-select').replaceWith(
    themedSelect(languages, config.language, (language) => {
      config.language = language;
      // The main process reloads this page in the new language once the config is saved.
      flushSave();
      scheduleSave();
    }),
  );

  $('deck-position-reset').addEventListener('click', () => api.resetDeckPosition());
  // Saved by the main process (like the corner grip of the deck), not by the editor's autosave.
  $('deck-scale').addEventListener('input', (e) => {
    config.deckScale = Number(e.target.value) / 100;
    renderDeckScale();
    api.setDeckScale(config.deckScale);
  });
  $('deck-scale-reset').addEventListener('click', () => {
    config.deckScale = 1;
    renderDeckScale();
    api.setDeckScale(1);
  });
  $('export-config').addEventListener('click', exportConfig);
  $('import-config').addEventListener('click', importConfig);

  setupHotkeyField();
}

function renderDeckPosition() {
  const saved = Boolean(config.deckPosition);
  $('deck-position-hint').textContent = t(saved ? 'settings.deckPositionSaved' : 'settings.deckPositionCursor');
  $('deck-position-reset').disabled = !saved;
}

function renderDeckScale() {
  const percent = Math.round((config.deckScale ?? 1) * 100);
  $('deck-scale').value = percent;
  $('deck-scale-value').textContent = `${percent} %`;
  $('deck-scale-reset').disabled = percent === 100;
}

function renderSettings() {
  renderDeckPosition();
  renderDeckScale();
  renderHotkey();
  renderConnectionForm();
  $('close-after').checked = config.closeAfterAction;
  $('login').checked = config.launchAtLogin;
}

(async () => {
  await loadI18n();
  document.title = t('editor.windowTitle');
  let update;
  [config, streamState, icons, update] = await Promise.all([
    api.getConfig(),
    api.streamState(),
    api.listIcons(),
    api.getUpdate(),
  ]);
  bindStaticFields();
  renderSettings();
  renderPreview();
  renderInspector();
  renderStreamState();
  renderUpdate(update);
  api.onUpdate(renderUpdate);
  // The deck position and size are changed from the deck itself, outside this page.
  api.onConfig((next) => {
    config.deckPosition = next.deckPosition;
    config.deckScale = next.deckScale;
    renderDeckPosition();
    renderDeckScale();
  });
  if (streamState.status === 'connected') refreshScenes();

  const firstLaunch =
    !config[config.software][software().secret] &&
    streamState.status !== 'connected' &&
    config.buttons.every((b) => b.action.type === 'none');
  if (pendingSelect !== null) {
    select(Math.min(pendingSelect, config.buttons.length - 1));
  } else if (sessionStorage.getItem('view')) {
    showView(sessionStorage.getItem('view'));
  } else if (firstLaunch) {
    showView('connection');
  }

  // Stream / recording timers on the preview keys.
  setInterval(() => {
    if (!document.hidden && hasRunningTimer(streamState)) markLiveScene();
  }, 1000);

  api.onStreamState((state) => {
    const changed = state.status !== streamState.status;
    streamState = state;
    renderStreamState();
    if (changed && state.status === 'connected') refreshScenes();
    // Update the "not connected" callout without stealing focus from a field being edited.
    if (changed && isStreamAction(current().action.type) && !$('action-fields').contains(document.activeElement)) {
      renderActionFields();
    }
  });
})();
