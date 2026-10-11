/* global api, t, I18N, loadI18n, createKey, createGlyph, renderDeckHeader, markKeys, countVerticalIssues
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
  { type: 'obs-record', icon: 'circle-dot', defaults: {} },
  { type: 'obs-stream', icon: 'radio', defaults: {} },
  { type: 'sound', icon: 'volume-2', defaults: { file: '', volume: 1 } },
  { type: 'open', icon: 'external-link', defaults: { target: '' } },
];

const SOURCE_MODES = ['flash', 'toggle', 'show', 'hide'];

// Connection form per streaming software: which config field holds the secret.
const SOFTWARE = {
  obs: { label: 'OBS', secret: 'password', secretLabel: 'conn.password', secretPlaceholder: 'conn.passwordPlaceholder' },
  streamlabs: { label: 'Streamlabs', secret: 'token', secretLabel: 'conn.token', secretPlaceholder: 'conn.tokenPlaceholder' },
};

let config = null;
let selected = 0;
let streamState = { status: 'disconnected' };
let icons = { names: [], tags: {} };
let saveTimer = null;
let dragFrom = null;
// Scene / source names fetched from the streaming software, offered as suggestions.
const streamLists = { scenes: [], verticalScenes: [], sources: [], verticalSources: [] };
// A button the main process asked us to select (from the deck) before config finished loading.
let pendingSelect = null;

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
  const { cols, rows } = config.grid;
  const preview = $('preview');
  preview.style.gridTemplateColumns = `repeat(${cols}, var(--key-size))`;
  preview.replaceChildren(
    ...config.buttons.slice(0, cols * rows).map((button, i) => {
      const key = createKey(button, i);
      key.classList.toggle('selected', i === selected);
      key.draggable = true;
      key.addEventListener('click', () => select(i));
      key.addEventListener('dragstart', () => (dragFrom = i));
      key.addEventListener('dragover', (e) => {
        e.preventDefault();
        key.classList.add('drop-target');
      });
      key.addEventListener('dragleave', () => key.classList.remove('drop-target'));
      key.addEventListener('drop', (e) => {
        e.preventDefault();
        swap(dragFrom, i);
      });
      return key;
    }),
  );
  markLiveScene();
  $('cols-value').value = cols;
  $('rows-value').value = rows;
  $('preview-hotkey').textContent = formatHotkey(config.hotkey).join(' + ');
}

function markLiveScene() {
  const buttons = config.buttons.slice(0, config.grid.cols * config.grid.rows);
  markKeys($('preview').children, buttons, streamState);
  const state = { ...streamState, label: software().label };
  renderDeckHeader($('preview-status'), state, countVerticalIssues(buttons, streamState));
}

function select(index) {
  selected = index;
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
  const count = config.grid.cols * config.grid.rows;
  while (config.buttons.length < count) config.buttons.push(emptyButton());
  if (selected >= count) selected = count - 1;
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
  $('button-number').textContent = t('editor.buttonN', { n: selected + 1 });
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

  if (isStreamAction(action.type) && streamState.status !== 'connected') container.append(offlineCallout());

  switch (action.type) {
    case 'obs-scene': {
      // The vertical field only exists with OBS + Aitum Vertical. It also stays visible while it
      // holds a value, so a vertical scene set earlier can still be seen and cleared.
      const showVertical = streamState.verticalAvailable || Boolean(action.verticalScene);
      container.append(
        field(
          t(showVertical ? 'field.horizontalScene' : 'field.scene'),
          textInput(action.scene, (scene) => updateAction({ scene }), {
            options: () => streamLists.scenes,
            placeholder: t(showVertical ? 'field.horizontalPlaceholder' : 'field.scenePlaceholder'),
          }),
        ),
      );
      if (showVertical) {
        container.append(
          field(
            t('field.verticalScene'),
            textInput(action.verticalScene, (verticalScene) => updateAction({ verticalScene }), {
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
          updateAction({ scene });
          refreshSources(scene);
        },
        { options: () => streamLists.scenes, placeholder: t('field.currentScenePlaceholder') },
      );
      const sourceInput = textInput(action.source, (source) => updateAction({ source }), {
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
            updateAction({ verticalScene });
            refreshVerticalSources(verticalScene);
          },
          { options: () => streamLists.verticalScenes, placeholder: t('field.currentVerticalScenePlaceholder') },
        );
        const verticalSourceInput = textInput(action.verticalSource, (verticalSource) => updateAction({ verticalSource }), {
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
      duration.addEventListener('input', () => updateAction({ duration: Number(duration.value) || 5 }));
      const durationField = field(t('field.duration'), duration, t('field.durationHint'));
      durationField.hidden = action.mode !== 'flash';

      container.append(
        field(
          t('field.behavior'),
          segmented(
            SOURCE_MODES.map((mode) => [mode, t(`mode.${mode}`)]),
            action.mode || 'toggle',
            (mode) => {
              updateAction({ mode });
              durationField.hidden = mode !== 'flash';
            },
          ),
        ),
        durationField,
      );
      refreshSources(action.scene);
      break;
    }

    case 'obs-record':
    case 'obs-stream':
      container.append(el('p', { className: 'muted', textContent: t(`action.${action.type}.hint`, { software: software().label }) }));
      break;

    case 'sound': {
      const name = el('span', { className: 'file-name', textContent: fileName(action.file) || t('field.noFile') });
      const volume = el('input', { type: 'range', min: 0, max: 100, value: Math.round((action.volume ?? 1) * 100) });
      const volumeValue = el('span', { className: 'range-value', textContent: `${volume.value} %` });
      volume.addEventListener('input', () => {
        volumeValue.textContent = `${volume.value} %`;
        updateAction({ volume: Number(volume.value) / 100 });
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
              updateAction({ file: picked.path });
            }),
          ),
          t('field.soundHint'),
        ),
        field(t('field.volume'), inline(volume, volumeValue)),
      );
      break;
    }

    case 'open': {
      const target = textInput(action.target, (value) => updateAction({ target: value }), {
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
              updateAction({ target: picked.path });
            }),
          ),
          t('field.targetHint'),
        ),
      );
      break;
    }

    default:
      break;
  }
}

async function refreshScenes() {
  [streamLists.scenes, streamLists.verticalScenes] = await Promise.all([api.streamScenes(), api.streamVerticalScenes()]);
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

function renderHotkey() {
  const parts = formatHotkey(config.hotkey);
  const nodes = [];
  parts.forEach((part, i) => {
    if (i) nodes.push(el('span', { className: 'plus', textContent: '+' }));
    nodes.push(el('kbd', { textContent: part }));
  });
  $('hotkey').replaceChildren(...nodes);
}

function setupHotkeyField() {
  const hotkeyButton = $('hotkey');
  let capturing = false;
  const stop = () => {
    if (!capturing) return;
    capturing = false;
    hotkeyButton.classList.remove('capturing');
    renderHotkey();
    api.pauseHotkey(false);
  };
  hotkeyButton.addEventListener('click', () => {
    if (capturing) return;
    capturing = true;
    api.pauseHotkey(true);
    hotkeyButton.classList.add('capturing');
    hotkeyButton.textContent = t('settings.hotkeyCapture');
  });
  hotkeyButton.addEventListener('blur', stop);
  hotkeyButton.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') return stop();
    const acc = acceleratorFromEvent(e);
    if (!acc) return;
    config.hotkey = acc;
    stop();
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
