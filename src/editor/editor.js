/* global PAGE_SIZE, pageGrid, pageTitle, isEmptyButton, api, t, I18N, loadI18n, createKey, createGlyph, renderDeckHeader, markKeys, countVerticalIssues, hasRunningTimer,
   TEMPLATES, TEMPLATE_CATEGORIES, buildTemplate
   -- api comes from preload.js, t/I18N/loadI18n from shared/i18n.js, the templates from shared/templates.js,
   the rest from shared/keys.js */
const $ = (id) => document.getElementById(id);

// Autosave once typing pauses for a second (closing the editor saves right away, see pagehide).
const SAVE_DEBOUNCE_MS = 1000;
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
  { type: 'media', icon: 'music', defaults: { key: 'playPause', repeat: 5 } },
  { type: 'keys', icon: 'keyboard', defaults: { keys: '' } },
  { type: 'text', icon: 'text-cursor-input', defaults: { text: '', enter: false } },
  {
    type: 'hue',
    icon: 'lightbulb',
    defaults: { mode: 'toggle', light: '', lightKind: '', lightName: '', scene: '', sceneName: '', brightness: '', color: '' },
  },
  {
    type: 'govee',
    icon: 'lamp-floor',
    defaults: { mode: 'toggle', device: '', deviceName: '', brightness: '', color: '' },
  },
  { type: 'page', icon: 'files', defaults: { page: 'next' } },
  { type: 'multi', icon: 'list-ordered', defaults: { steps: [] } },
];

// What a step of a multi-action can do: any action but "none" and another multi-action.
const STEP_ACTIONS = ACTIONS.filter((action) => !['none', 'multi'].includes(action.type));

const SOURCE_MODES = ['flash', 'toggle', 'show', 'hide'];
// Canvases a stream / record / clip key can act on (action.target).
const OUTPUT_TARGETS = ['horizontal', 'vertical', 'both'];
const MUTE_MODES = ['toggle', 'mute', 'unmute'];
const HUE_MODES = ['toggle', 'on', 'off', 'scene'];
const GOVEE_MODES = ['toggle', 'on', 'off'];
// Media keys (keyboard.js MEDIA), in the order of a player's buttons.
const MEDIA_KEYS = ['playPause', 'prev', 'next', 'stop', 'volumeDown', 'volumeUp', 'volumeMute', 'micMute'];
// Presses per volume key: Windows moves the volume by 2 % on each.
const VOLUME_STEPS = [1, 5, 10];
// Modifiers of a key combination, in the order Windows writes them ("Win + Ctrl + Alt + Shift").
const COMBO_MODIFIERS = ['Super', 'Control', 'Alt', 'Shift'];
const MAX_TEXT = 2000;
const HUE_BRIGHTNESS = [10, 25, 50, 75, 100];
// Colours a Hue key can set: the whites are colour temperatures (saved by name), the others RGB.
const HUE_WHITES = ['warm', 'neutral', 'cool'];
const HUE_COLORS = [
  ['warm', '#ffc47e'],
  ['neutral', '#fff2df'],
  ['cool', '#dde8ff'],
  ['red', '#ff0000'],
  ['orange', '#ff7a00'],
  ['amber', '#ffc400'],
  ['green', '#00e05a'],
  ['teal', '#00d8d0'],
  ['blue', '#1f4dff'],
  ['violet', '#8a2bff'],
  ['pink', '#ff2fa8'],
];

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
// Grid of the page shown: each page has its own (config.pageGrids, see config.js).
const currentGrid = () => pageGrid(config, page);
const perPage = () => currentGrid().cols * currentGrid().rows;
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
  recordChange();
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

// ---------- Undo / redo (Ctrl+Z, Ctrl+Y) ----------
// Keys and pages only (not the settings), kept in memory while the editor is open: nothing more
// is written to disk.

const HISTORY_MAX = 50;
// Typing in a field is one change, not one per letter.
const TYPING_MERGE_MS = 1500;
const undoStack = [];
const redoStack = [];
// The keys and pages as they are now (JSON), to compare with after each change.
let deckNow = null;
let lastEdit = { at: 0, field: null };

const deckJson = () =>
  JSON.stringify({
    buttons: config.buttons,
    pageCount: config.pageCount,
    pageGrids: config.pageGrids,
    pageNames: config.pageNames,
    grid: config.grid,
  });

const isTextField = (node) =>
  node instanceof HTMLTextAreaElement ||
  (node instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'file', 'color'].includes(node.type));

// Starts the history over (config loaded or imported).
function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  deckNow = deckJson();
  lastEdit = { at: 0, field: null };
}

// Called on every save: puts what the keys were before the change in the history.
function recordChange() {
  const next = deckJson();
  if (next === deckNow) return;
  const field = isTextField(document.activeElement) ? document.activeElement : null;
  const typing = field && field === lastEdit.field && Date.now() - lastEdit.at < TYPING_MERGE_MS;
  if (!typing) {
    undoStack.push(deckNow);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
  }
  redoStack.length = 0;
  lastEdit = { at: Date.now(), field };
  deckNow = next;
}

// Puts the keys back as they were, and shows the first key (or page) that changed.
function restoreDeck(from, to) {
  const previous = JSON.parse(deckNow);
  to.push(deckNow);
  deckNow = from.pop();
  Object.assign(config, JSON.parse(deckNow));
  lastEdit = { at: 0, field: null };
  const pages = Math.max(previous.pageCount, config.pageCount);
  const changedKey = config.buttons.findIndex((b, i) => JSON.stringify(b) !== JSON.stringify(previous.buttons[i]));
  const changedPage = Array.from({ length: pages }, (_, p) => p).find(
    (p) =>
      JSON.stringify(config.pageGrids[p]) !== JSON.stringify(previous.pageGrids[p]) ||
      config.pageNames[p] !== previous.pageNames[p],
  );
  let index = changedKey >= 0 ? changedKey : changedPage !== undefined ? changedPage * PAGE_SIZE : selected;
  if (Math.floor(index / PAGE_SIZE) >= config.pageCount) index = (config.pageCount - 1) * PAGE_SIZE;
  if (index >= config.buttons.length) index = config.buttons.length - 1;
  showView('buttons');
  select(index);
  setStatus(t('save.saving'));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

function undo() {
  if (!undoStack.length) return false;
  restoreDeck(undoStack, redoStack);
  return true;
}

function redo() {
  if (!redoStack.length) return false;
  restoreDeck(redoStack, undoStack);
  return true;
}

// In a text field, Ctrl+Z undoes the typing, as everywhere. Fields recording a shortcut keep it.
document.addEventListener('keydown', (e) => {
  if (!config || e.defaultPrevented || !e.ctrlKey || e.altKey || e.metaKey) return;
  if (isTextField(e.target) || e.target.isContentEditable) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
  if ((isUndo && undo()) || (isRedo && redo())) e.preventDefault();
});

// ---------- Confirmation (in the app's look, not Windows' white box) ----------

// Resolves true when the user confirms. Escape, Cancel or a click beside the box: false.
function confirmDialog(text, okLabel) {
  const dialog = $('confirm-dialog');
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const close = (confirmed) => {
      dialog.removeEventListener('close', onClose);
      dialog.onclick = null;
      $('confirm-ok').onclick = null;
      $('confirm-cancel').onclick = null;
      if (dialog.open) dialog.close();
      resolve(confirmed);
    };
    const onClose = () => close(false);
    dialog.addEventListener('close', onClose);
    $('confirm-ok').onclick = () => close(true);
    $('confirm-cancel').onclick = () => close(false);
    // Around the box, the click lands on the dialog itself (its backdrop): it cancels.
    dialog.onclick = (e) => e.target === dialog && close(false);
    dialog.showModal();
    $('confirm-ok').focus();
  });
}

// ---------- Tabs ----------

function showView(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  watchPhone(name === 'settings');
  if (name === 'settings') refreshHueSettings();
  if (name === 'library') renderLibrary();
  // Survives the page reload that follows a language change.
  sessionStorage.setItem('view', name);
}

// ---------- Preview ----------

function renderPreview() {
  const { cols, rows } = currentGrid();
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
  $('rows-value').value = rows;
  // An empty page: a template is a quick way to fill it.
  $('empty-page-hint').hidden = !isPageEmpty(page);
  $('preview-hotkey').textContent = formatHotkey(config.hotkey).join(' + ');
}

// Page tabs above the preview: one per page, "+" to add one, "×" to delete the page shown.
function renderPageTabs() {
  const tabs = [];
  for (let p = 0; p < config.pageCount; p++) {
    const name = config.pageNames[p];
    const tab = el('button', { type: 'button', className: 'page-tab', textContent: name || String(p + 1), title: pageTitle(config, p) });
    tab.classList.toggle('selected', p === page);
    tab.addEventListener('click', () => select(p * PAGE_SIZE));
    acceptKeyDrops(tab, p);
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
  // Naming a page only makes sense once there are several.
  $('page-name-field').hidden = config.pageCount <= 1;
  $('page-name').placeholder = t('page.n', { n: page + 1 });
  // Not while typing in it: the saved name is trimmed, the field must keep the space just typed.
  if (document.activeElement !== $('page-name')) $('page-name').value = config.pageNames[page];
}

// A key dragged onto a page tab: held there a moment, the page opens (to drop it on a precise
// spot); dropped on the tab, it goes to that page's first free spot.
const TAB_OPEN_DELAY_MS = 600;
let tabOpenTimer = null;

function acceptKeyDrops(tab, p) {
  tab.addEventListener('dragover', (e) => {
    if (dragFrom === null || p === page) return;
    e.preventDefault();
    tab.classList.add('drop-target');
    if (!tabOpenTimer) tabOpenTimer = setTimeout(() => ((tabOpenTimer = null), select(p * PAGE_SIZE)), TAB_OPEN_DELAY_MS);
  });
  tab.addEventListener('dragleave', () => {
    tab.classList.remove('drop-target');
    clearTimeout(tabOpenTimer);
    tabOpenTimer = null;
  });
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    clearTimeout(tabOpenTimer);
    tabOpenTimer = null;
    moveToPage(dragFrom, p, tab);
  });
}

function moveToPage(from, p, tab) {
  const { cols, rows } = pageGrid(config, p);
  const free = Array.from({ length: cols * rows }, (_, i) => p * PAGE_SIZE + i).find((i) => isEmptyButton(config.buttons[i]));
  if (from === null || free === undefined) {
    dragFrom = null;
    tab.classList.remove('drop-target');
    // No free spot: say so on the tab itself.
    tab.classList.remove('refused');
    void tab.offsetWidth;
    tab.classList.add('refused');
    tab.title = t('page.full', { name: pageTitle(config, p) });
    return;
  }
  swap(from, free);
}

document.addEventListener('dragend', () => {
  clearTimeout(tabOpenTimer);
  tabOpenTimer = null;
});

// Pads the buttons so every page but the last is full (see PAGE_SIZE in config.js).
function padPages() {
  const last = pageGrid(config, config.pageCount - 1);
  while (config.buttons.length < (config.pageCount - 1) * PAGE_SIZE + last.cols * last.rows) config.buttons.push(emptyButton());
}

// The new page starts with the grid of the page shown.
function addPage() {
  config.pageGrids.push({ ...currentGrid() });
  config.pageNames.push('');
  config.pageCount += 1;
  padPages();
  select((config.pageCount - 1) * PAGE_SIZE);
  scheduleSave();
}

async function removePage() {
  const name = pageTitle(config, page);
  if (!(await confirmDialog(t('page.removeConfirm', { name }), t('page.removeOk')))) return;
  config.buttons.splice(pageStart(), PAGE_SIZE);
  config.pageGrids.splice(page, 1);
  config.pageNames.splice(page, 1);
  config.grid = { ...config.pageGrids[0] };
  config.pageCount -= 1;
  padPages();
  select(Math.min(page, config.pageCount - 1) * PAGE_SIZE);
  scheduleSave();
  showCanvasNotice(t('undo.pageRemoved', { name }), false, true);
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

// Changes the grid of the page shown only.
function stepGrid(axis, delta) {
  const max = axis === 'cols' ? 8 : 6;
  const grid = currentGrid();
  grid[axis] = Math.min(max, Math.max(1, grid[axis] + delta));
  // Page 1's grid is also `grid` (see config.js).
  config.grid = { ...config.pageGrids[0] };
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
  $('button-number').textContent = config.pageCount > 1 ? `${pageTitle(config, page)} · ${number}` : number;
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

// Hue and Govee actions are only offered while turned on in the settings (a key already using
// one keeps showing it).
const offered = (type, currentType) => type === currentType || !['hue', 'govee'].includes(type) || config.lights[type];

function renderActionTiles() {
  const type = current().action.type;
  $('action-tiles').replaceChildren(
    ...ACTIONS.filter((action) => offered(action.type, type)).map((action) => {
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

// "Open" keys: take the opened program's icon (Spotify, OBS…) as the key's picture, on request.
function appIconField(target) {
  const status = el('span', { className: 'muted' });
  const take = button(t('field.appIcon'), async () => {
    take.disabled = true;
    status.textContent = '';
    const icon = await api.programIcon(target.value.trim());
    take.disabled = false;
    if (!icon) {
      status.textContent = t('field.appIconNone');
      return;
    }
    updateButton({ image: icon.path, imageUrl: icon.url });
    renderInspector();
  });
  take.prepend(createGlyph('image'));
  return el('div', { className: 'inline app-icon' }, take, status);
}

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
      STEP_ACTIONS.filter((a) => offered(a.type, step.action?.type)).map((a) => [a.type, t(`action.${a.type}`)]),
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
        appIconField(target),
      );
      break;
    }

    case 'media': {
      const key = MEDIA_KEYS.includes(action.key) ? action.key : 'playPause';
      container.append(
        el('p', { className: 'muted', textContent: t('action.media.hint') }),
        field(
          t('field.mediaKey'),
          themedSelect(
            MEDIA_KEYS.map((value) => [value, t(`media.${value}`)]),
            key,
            (value) => {
              update({ key: value });
              rerender();
            },
          ),
        ),
      );
      if (key === 'micMute') {
        container.append(
          field(
            t('field.behavior'),
            segmented(
              MUTE_MODES.map((mode) => [mode, t(`muteMode.${mode}`)]),
              action.mode || 'toggle',
              (mode) => update({ mode }),
            ),
            t('field.micMuteHint'),
          ),
        );
      }
      if (key.startsWith('volume') && key !== 'volumeMute') {
        container.append(
          field(
            t('field.volumeStep'),
            segmented(
              VOLUME_STEPS.map((n) => [n, `${n * 2} %`]),
              VOLUME_STEPS.includes(action.repeat) ? action.repeat : 5,
              (repeat) => update({ repeat }),
            ),
          ),
        );
      }
      break;
    }

    case 'keys':
      container.append(el('p', { className: 'muted', textContent: t('action.keys.hint') }), comboField(action, update));
      break;

    case 'text': {
      const text = el('textarea', { value: action.text || '', maxLength: MAX_TEXT, rows: 4, spellcheck: true });
      text.placeholder = t('field.textPlaceholder');
      text.addEventListener('input', () => update({ text: text.value }));
      const enter = el('input', { type: 'checkbox', checked: action.enter === true });
      enter.addEventListener('change', () => update({ enter: enter.checked }));
      container.append(
        el('p', { className: 'muted', textContent: t('action.text.hint') }),
        field(t('field.text'), text),
        el(
          'div',
          { className: 'toggle-row' },
          el('span', { textContent: t('field.textEnter') }),
          el('label', { className: 'switch' }, enter, el('span')),
        ),
      );
      break;
    }

    case 'hue':
    case 'govee':
      if (!config.lights[action.type]) container.append(lightsOffCallout(action.type));
      else if (action.type === 'hue') fillHueFields(container, action, update, rerender);
      else fillGoveeFields(container, action, update, rerender);
      break;

    case 'page': {
      const pages = Array.from({ length: config.pageCount }, (_, p) => [String(p + 1), pageTitle(config, p)]);
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

// ---------- Key combination sent by a key ("keys" action) ----------

// Sent, not registered: any key may stand alone, and a few more keys than hotkeys are allowed.
const SEND_ONLY_KEYS = { Escape: 'Escape', Backspace: 'Backspace', PrintScreen: 'PrintScreen' };
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'OS'];

function comboFromEvent(e) {
  const key = keyFromEvent(e) || SEND_ONLY_KEYS[e.code];
  if (!key) return null;
  const held = { Super: e.metaKey, Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey };
  return [...COMBO_MODIFIERS.filter((mod) => held[mod]), key].join('+');
}

// "Control+Shift+M" -> { mods: ['Control', 'Shift'], key: 'M' }.
function splitCombo(accelerator) {
  const parts = accelerator ? accelerator.split('+') : [];
  const key = parts.pop() || '';
  return { mods: COMBO_MODIFIERS.filter((mod) => parts.includes(mod)), key };
}

// Records the combination from the keyboard; the Ctrl / Alt / Shift / Win buttons below add or
// remove a modifier (Windows keeps most Win + … combinations for itself, they never reach the page).
function comboField(action, update) {
  const capture = el('button', { type: 'button', className: 'hotkey' });
  const chips = el('div', { className: 'combo-mods' });
  let capturing = false;

  const set = (accelerator) => {
    action.keys = accelerator;
    update({ keys: accelerator });
    render();
  };
  function render() {
    if (action.keys) renderAccelerator(capture, action.keys);
    else capture.replaceChildren(el('span', { className: 'muted', textContent: t('field.keysCapture') }));
    const { mods, key } = splitCombo(action.keys);
    chips.replaceChildren(
      ...COMBO_MODIFIERS.map((mod) => {
        const chip = el('button', { type: 'button', className: 'combo-mod', textContent: formatHotkey(mod)[0], disabled: !key });
        chip.classList.toggle('selected', mods.includes(mod));
        chip.setAttribute('aria-pressed', String(mods.includes(mod)));
        chip.addEventListener('click', () => {
          const next = mods.includes(mod) ? mods.filter((m) => m !== mod) : [...mods, mod];
          set([...COMBO_MODIFIERS.filter((m) => next.includes(m)), key].join('+'));
        });
        return chip;
      }),
    );
  }
  const stop = () => {
    if (!capturing) return;
    capturing = false;
    capture.classList.remove('capturing');
    render();
    api.pauseHotkey(false);
  };
  const pick = (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;
    set(combo);
    stop();
  };
  capture.addEventListener('click', () => {
    if (capturing) return;
    capturing = true;
    // So the deck's and the keys' hotkeys reach the page instead of running.
    api.pauseHotkey(true);
    capture.classList.add('capturing');
    capture.textContent = t('settings.hotkeyCapture');
  });
  capture.addEventListener('blur', stop);
  capture.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    if (MODIFIER_KEYS.includes(e.key)) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return stop();
    pick(e);
  });
  // Windows only lets the page see Print Screen when it is released.
  capture.addEventListener('keyup', (e) => {
    if (capturing && e.code === 'PrintScreen') pick(e);
  });
  render();
  return field(t('field.keys'), el('div', { className: 'combo-capture' }, capture, chips), t('field.keysHint'));
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
  resetHistory();
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

// ---------- Library of templates (shared/templates.js) ----------

let libraryFilter = 'all';
let noticeTimer = null;
const NOTICE_MS = 10000;

// A message above the page tabs (a template just added, a page deleted), gone after a while.
// undoable: adds an "Undo" button, for a change that may have been a mistake.
function showCanvasNotice(text, warn = false, undoable = false) {
  const notice = $('canvas-notice');
  notice.textContent = text;
  if (undoable) {
    const steps = undoStack.length;
    const cancel = button(t('undo.button'), () => {
      // Only if nothing else changed since: else Ctrl+Z goes back step by step.
      if (undoStack.length === steps) undo();
      notice.hidden = true;
    }, 'link-btn');
    cancel.title = t('undo.hint');
    notice.append(' ', cancel);
  }
  notice.classList.toggle('warn', warn);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), NOTICE_MS);
}

const isPageEmpty = (p) => {
  const { cols, rows } = pageGrid(config, p);
  return config.buttons.slice(p * PAGE_SIZE, p * PAGE_SIZE + cols * rows).every(isEmptyButton);
};

function renderLibrary() {
  const filters = ['all', ...TEMPLATE_CATEGORIES].map((category) => [category, t(`library.category.${category}`)]);
  const picker = segmented(filters, libraryFilter, (category) => {
    libraryFilter = category;
    renderLibraryCards();
  });
  picker.id = 'library-filters';
  picker.classList.add('library-filters');
  $('library-filters').replaceWith(picker);
  renderLibraryCards();
}

function renderLibraryCards() {
  const shown = TEMPLATES.filter((template) => libraryFilter === 'all' || template.category === libraryFilter);
  $('library-grid').replaceChildren(...shown.map(templateCard));
}

function templateCard(template) {
  const built = buildTemplate(template);
  const preview = el('div', { className: 'keys template-keys' });
  preview.style.gridTemplateColumns = `repeat(${template.grid.cols}, var(--key-size))`;
  preview.append(...built.buttons.map((b, i) => createKey(b, i)));
  for (let i = built.buttons.length; i < template.grid.cols * template.grid.rows; i++) {
    preview.append(createKey({ ...emptyButton(), color: DEFAULT_COLOR }, i));
  }
  // Only a picture: the keys can't be pressed or focused here.
  preview.inert = true;

  const tags = el('div', { className: 'template-tags' }, el('span', { className: 'tag', textContent: t('library.keyCount', { count: built.buttons.length }) }));
  if (template.needsStream) tags.append(el('span', { className: 'tag accent', textContent: t('library.needsStream') }));
  const add = button(t('library.add'), () => addTemplate(template), 'btn primary');
  add.prepend(createGlyph('plus'));
  return el(
    'article',
    { className: 'template-card' },
    el('div', { className: 'template-preview' }, preview),
    el(
      'div',
      { className: 'template-body' },
      el('h3', {}, createGlyph(template.icon), el('span', { textContent: built.name })),
      el('p', { className: 'muted', textContent: t(`tpl.${template.id}.description`) }),
      el('div', { className: 'template-foot' }, tags, add),
    ),
  );
}

// Adds a template as a new page (or on the first page, while the deck is still all empty).
// The keys already there never move.
async function addTemplate(template) {
  const lists = template.needsStream && streamState.status === 'connected'
    ? { scenes: await api.streamScenes(), inputs: await api.streamInputs() }
    : {};
  const built = buildTemplate(template, lists);
  const blankDeck = config.pageCount === 1 && config.buttons.every(isEmptyButton);
  if (!blankDeck && config.pageCount >= MAX_PAGES) {
    showView('buttons');
    showCanvasNotice(t('library.noRoom', { max: MAX_PAGES }), true);
    return;
  }
  const p = blankDeck ? 0 : config.pageCount;
  if (!blankDeck) {
    config.pageCount += 1;
    config.pageGrids.push({ ...built.grid });
    config.pageNames.push(built.name);
  } else {
    config.pageGrids[0] = { ...built.grid };
    // A single page has no name shown; it gets one once a second page is added.
    config.pageNames[0] = built.name;
  }
  config.grid = { ...config.pageGrids[0] };
  padPages();
  built.buttons.forEach((b, i) => {
    config.buttons[p * PAGE_SIZE + i] = { ...emptyButton(), ...b, id: crypto.randomUUID(), imageUrl: '' };
  });
  showView('buttons');
  select(p * PAGE_SIZE);
  scheduleSave();
  let message = t(blankDeck ? 'library.addedFirst' : 'library.added', { name: built.name });
  if (built.todo) message += ` ${t('library.todo', { count: built.todo })}`;
  if (template.needsStream && streamState.status !== 'connected') message += ` ${t('library.connectFirst', { software: software().label })}`;
  showCanvasNotice(message, Boolean(built.todo), true);
}

// ---------- Updates ----------

// update: { version, oneClick, progress } from main.js, or null.
function renderUpdate(update) {
  const pill = $('update-pill');
  pill.hidden = !update;
  if (!update) return;
  const { version, oneClick, progress } = update;
  const downloading = progress !== null;
  pill.disabled = downloading;
  $('update-pill-text').textContent = downloading
    ? t('update.downloading', { percent: progress })
    : t(oneClick ? 'update.install' : 'update.pill', { version });
  pill.title = downloading ? '' : t(oneClick ? 'update.installTitle' : 'update.pillTitle');
}

// ---------- Wiring ----------

function bindStaticFields() {
  $('brand-glyph').replaceWith(createGlyph('layout-grid'));
  $('search-glyph').replaceWith(createGlyph('search'));
  $('clear-button').append(createGlyph('trash-2'));
  $('confirm-glyph').append(createGlyph('triangle-alert'));

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  $('stream-pill').addEventListener('click', () => showView('connection'));
  $('empty-page-glyph').replaceWith(createGlyph('layout-template'));
  $('empty-page-open').addEventListener('click', () => showView('library'));
  $('update-glyph').replaceWith(createGlyph('download'));
  $('update-pill').addEventListener('click', () => api.installUpdate());

  document.querySelectorAll('.stepper').forEach((stepper) => {
    stepper.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => stepGrid(stepper.dataset.axis, Number(b.dataset.step))),
    );
  });

  $('label').addEventListener('input', (e) => updateButton({ label: e.target.value }));
  $('page-name').addEventListener('input', (e) => {
    config.pageNames[page] = e.target.value.trim();
    renderPageTabs();
    renderHead();
    scheduleSave();
  });
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
    const wasEmpty = isEmptyButton(current());
    const name = current().label || t('editor.buttonN', { n: (selected % PAGE_SIZE) + 1 });
    config.buttons[selected] = emptyButton();
    renderPreview();
    renderInspector();
    scheduleSave();
    if (!wasEmpty) showCanvasNotice(t('undo.keyRemoved', { name }), false, true);
  });

  $('hue-enabled').addEventListener('change', (e) => setLights('hue', e.target.checked));
  $('govee-enabled').addEventListener('change', (e) => setLights('govee', e.target.checked));
  $('close-after').addEventListener('change', (e) => {
    config.closeAfterAction = e.target.checked;
    scheduleSave();
  });
  $('close-outside').addEventListener('change', (e) => {
    config.closeOnClickOutside = e.target.checked;
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
  $('page-mode').replaceWith(
    segmented(
      [
        ['replace', t('pageMode.replace')],
        ['popup', t('pageMode.popup')],
      ],
      config.pageMode || 'replace',
      (mode) => {
        config.pageMode = mode;
        scheduleSave();
      },
    ),
  );
  // Saved by the main process (like the corner grip of the deck), not by the editor's autosave.
  // Live preview while dragging; saved once on release.
  $('deck-scale').addEventListener('input', (e) => {
    config.deckScale = Number(e.target.value) / 100;
    renderDeckScale();
    api.previewDeckScale(config.deckScale);
  });
  $('deck-scale').addEventListener('change', () => api.setDeckScale(config.deckScale));
  $('deck-scale-reset').addEventListener('click', () => {
    config.deckScale = 1;
    renderDeckScale();
    api.setDeckScale(1);
  });
  $('export-config').addEventListener('click', exportConfig);
  $('import-config').addEventListener('click', importConfig);
  setupPhone();

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

// ---------- Connected lights (Settings) ----------

function openLightsSettings() {
  showView('settings');
  $('lights-card').scrollIntoView({ block: 'center' });
}

// A key of a light brand turned off in the settings: kept as is, and says how to turn it back on.
function lightsOffCallout(kind) {
  return el(
    'div',
    { className: 'callout' },
    createGlyph('lightbulb-off'),
    el('span', { textContent: t(`lights.${kind}Off`) }),
    button(t('lights.openSettings'), openLightsSettings),
  );
}

function renderLightsSettings() {
  $('hue-enabled').checked = config.lights.hue;
  $('govee-enabled').checked = config.lights.govee;
  $('hue-card').hidden = !config.lights.hue;
}

async function setLights(kind, on) {
  config.lights[kind] = on;
  renderLightsSettings();
  // Right away: until then the app refuses to contact these lights.
  scheduleSave();
  await flushSave();
  if (kind === 'hue' && on) refreshHueSettings();
  // Its tile appears or goes, and a key using it shows its fields or the callout.
  renderInspector();
}

// ---------- Philips Hue ----------

// Lights, rooms and scenes of the paired bridge ({ targets, scenes } or { error }), loaded the first
// time a Hue key is shown.
let hueLists = null;
let hueListsLoading = null;

function loadHueLists() {
  hueListsLoading ??= api.hueLights().then((lists) => {
    hueLists = lists;
    hueListsLoading = null;
  });
  return hueListsLoading;
}

function hueTargetLabel(target) {
  if (target.kind === 'all') return t('hue.all');
  if (target.kind === 'room' || target.kind === 'zone') return t(`hue.${target.kind}`, { name: target.name });
  return target.name;
}

// A choice list that still shows a light or scene the bridge no longer has (or couldn't list).
function hueOptions(options, value, savedName, pickText) {
  if (!value) return [['', pickText], ...options];
  if (options.some(([id]) => id === value)) return options;
  return [[value, t('hue.missing', { name: savedName || '?' })], ...options];
}

function fillHueFields(container, action, update, rerender) {
  if (!config.hue?.paired) {
    container.append(
      el(
        'div',
        { className: 'callout' },
        createGlyph('lightbulb-off'),
        el('span', { textContent: t('hue.notPairedCallout') }),
        button(t('hue.openSettings'), openLightsSettings),
      ),
    );
    return;
  }
  if (!hueLists) {
    container.append(el('p', { className: 'muted', textContent: t('hue.loading') }));
    loadHueLists().then(rerender);
    return;
  }
  if (hueLists.error) container.append(el('p', { className: 'muted warn', textContent: hueLists.error }));
  const targets = hueLists.targets || [];
  const mode = action.mode || 'toggle';
  container.append(
    field(
      t('field.behavior'),
      segmented(
        HUE_MODES.map((value) => [value, t(`hueMode.${value}`)]),
        mode,
        (value) => {
          update({ mode: value });
          rerender();
        },
      ),
    ),
  );

  if (mode === 'scene') {
    // Scenes belong to a room or zone: named after it, as in the Hue app.
    const areaName = (area) => targets.find((target) => target.area === area)?.name;
    const scenes = (hueLists.scenes || []).map((scene) => [
      scene.id,
      areaName(scene.area) ? `${scene.name} · ${areaName(scene.area)}` : scene.name,
    ]);
    const options = hueOptions(scenes, action.scene, action.sceneName, t('hue.pickScene'));
    container.append(
      field(
        t('field.hueScene'),
        themedSelect(options, action.scene || '', (id) => update({ scene: id, sceneName: options.find(([v]) => v === id)?.[1] || '' })),
      ),
    );
  } else {
    const lights = targets.map((target) => [target.id, hueTargetLabel(target)]);
    const options = hueOptions(lights, action.light, action.lightName, t('hue.pickLight'));
    container.append(
      field(
        t('field.hueLight'),
        themedSelect(options, action.light || '', (id) => {
          const target = targets.find((item) => item.id === id);
          if (target) update({ light: id, lightKind: target.kind, lightName: hueTargetLabel(target) });
        }),
      ),
    );
  }

  lightLookFields(container, action, update, mode);
}

// Brightness and colour of a Hue or Govee key, for the modes that turn lights on.
function lightLookFields(container, action, update, mode) {
  if (mode !== 'off') {
    const levels = [['', t('hue.keep')], ...HUE_BRIGHTNESS.map((n) => [String(n), `${n} %`])];
    container.append(
      field(
        t('field.hueBrightness'),
        themedSelect(levels, String(action.brightness || ''), (value) => update({ brightness: value ? Number(value) : '' })),
      ),
    );
  }
  if (mode === 'on' || mode === 'toggle') container.append(field(t('field.hueColor'), lightSwatches(action, update)));
  if (mode === 'toggle') container.append(el('p', { className: 'muted', textContent: t('hue.toggleHint') }));
}

// Colour of a light key: unchanged, a white, a preset colour or any colour.
function lightSwatches(action, update) {
  const wrap = el('div', { className: 'swatches' });
  const pick = (value) => {
    update({ color: value });
    render();
  };
  function render() {
    const color = (action.color || '').toLowerCase();
    const none = el('button', { type: 'button', className: 'swatch none', title: t('hue.keepColor') }, createGlyph('ban'));
    none.classList.toggle('selected', !color);
    none.addEventListener('click', () => pick(''));
    const presets = HUE_COLORS.map(([name, shown]) => {
      const white = HUE_WHITES.includes(name);
      const value = white ? name : shown;
      const swatch = el('button', { type: 'button', className: 'swatch', title: t(white ? `hue.white.${name}` : `color.${name}`) });
      swatch.style.setProperty('--swatch', shown);
      swatch.classList.toggle('selected', color === value);
      swatch.addEventListener('click', () => pick(value));
      return swatch;
    });
    const isCustom = color.startsWith('#') && !HUE_COLORS.some(([, shown]) => shown === color);
    const picker = el('input', { type: 'color', value: isCustom ? color : '#ff7a00', title: t('color.custom') });
    const custom = el('label', { className: 'swatch custom', title: t('color.custom') }, picker);
    if (isCustom) {
      custom.classList.add('selected');
      custom.style.setProperty('--swatch', color);
    }
    picker.addEventListener('input', () => update({ color: picker.value }));
    picker.addEventListener('change', render);
    wrap.replaceChildren(none, ...presets, custom);
  }
  render();
  return wrap;
}

// ---------- Govee ----------

// Govee lights found on the network ([{ id, sku, ip }]), searched the first time a Govee key is
// shown (a search takes 2 seconds). goveeError: why the search couldn't run.
let goveeLights = null;
let goveeError = '';
let goveeSearch = null;

function searchGovee() {
  goveeSearch ??= api
    .goveeDiscover()
    .then((result) => {
      goveeLights = result.lights;
      goveeError = result.error || '';
    })
    .finally(() => (goveeSearch = null));
  return goveeSearch;
}

// "H6076 · 1C:13": the model and the end of the light's id (the local API doesn't give its name).
const goveeLabel = (light) => `${light.sku || 'Govee'} · ${light.id.slice(-5)}`;

function fillGoveeFields(container, action, update, rerender) {
  if (!goveeLights) {
    container.append(el('p', { className: 'muted', textContent: t('govee.searching') }));
    searchGovee().then(rerender);
    return;
  }
  const mode = action.mode || 'toggle';
  container.append(
    field(
      t('field.behavior'),
      segmented(
        GOVEE_MODES.map((value) => [value, t(`hueMode.${value}`)]),
        mode,
        (value) => {
          update({ mode: value });
          rerender();
        },
      ),
    ),
  );
  const lights = [['all', t('govee.all')], ...goveeLights.map((light) => [light.id, goveeLabel(light)])];
  const options = hueOptions(lights, action.device, action.deviceName, t('govee.pick'));
  const searchAgain = button(t('govee.searchAgain'), () => {
    goveeLights = null;
    rerender();
  });
  container.append(
    field(
      t('field.goveeLight'),
      inline(
        themedSelect(options, action.device || '', (id) => update({ device: id, deviceName: options.find(([v]) => v === id)?.[1] || '' })),
        searchAgain,
      ),
      goveeError || t(goveeLights.length ? 'govee.lanHint' : 'govee.noneFound'),
    ),
  );
  lightLookFields(container, action, update, mode);
}

// Settings › Philips Hue. Pairing: find the bridge, then press its button within 30 seconds.
const HUE_PAIR_SECONDS = 30;
const HUE_PAIR_RETRY_MS = 2000;
let hueStatus = { paired: false, name: '', ip: '' };
// Bridges found by the last search: null before any, 'searching' during one.
let hueFound = null;
let hueManualIp = '';
let huePairing = false;

function settingRow(title, hint, ...controls) {
  const text = el('div', { className: 'setting-text' }, el('p', { className: 'setting-title', textContent: title }));
  if (hint) text.append(el('p', { className: 'muted', textContent: hint }));
  return el('div', { className: 'setting' }, text, ...controls);
}

function renderHueSettings(message = '', warn = false) {
  const rows = [];
  if (hueStatus.paired) {
    rows.push(
      settingRow(
        t('hue.paired', { name: hueStatus.name }),
        t('hue.pairedHint', { ip: hueStatus.ip }),
        button(t('hue.forget'), async () => {
          hueStatus = await api.hueForget();
          hueLists = null;
          hueFound = null;
          renderHueSettings();
        }),
      ),
    );
  } else {
    const searching = hueFound === 'searching';
    const search = button(t(searching ? 'hue.searching' : 'hue.search'), searchHue);
    search.disabled = searching || huePairing;
    rows.push(settingRow(t('hue.bridge'), t('hue.bridgeHint'), search));
    if (Array.isArray(hueFound)) {
      for (const bridge of hueFound) {
        const pair = button(t('hue.pair'), () => pairHue(bridge.ip));
        pair.disabled = huePairing;
        rows.push(settingRow(bridge.name, bridge.ip, pair));
      }
      // Not found (or another one): its address, from the Hue app.
      const ip = el('input', { className: 'hue-ip', value: hueManualIp, placeholder: '192.168.1.20', spellcheck: false });
      ip.addEventListener('input', () => (hueManualIp = ip.value.trim()));
      const pair = button(t('hue.pair'), () => pairHue(hueManualIp));
      pair.disabled = huePairing;
      rows.push(settingRow(t('hue.manual'), t(hueFound.length ? 'hue.manualHint' : 'hue.noneFound'), inline(ip, pair)));
    }
  }
  if (message) rows.push(el('p', { className: `hue-status${warn ? ' warn' : ''}`, textContent: message }));
  $('hue-card').replaceChildren(...rows);
}

async function refreshHueSettings() {
  if (!config.lights.hue || huePairing || hueFound === 'searching') return;
  hueStatus = await api.hueStatus();
  renderHueSettings();
}

async function searchHue() {
  hueFound = 'searching';
  renderHueSettings();
  hueFound = await api.hueDiscover();
  renderHueSettings();
}

// Asks the bridge again every 2 seconds while the user goes to press its button.
async function pairHue(ip) {
  if (huePairing || !ip) return;
  huePairing = true;
  const deadline = Date.now() + HUE_PAIR_SECONDS * 1000;
  let message = '';
  let warn = true;
  for (;;) {
    const result = await api.huePair(ip);
    if (result.ok) {
      hueStatus = result.status;
      hueFound = null;
      hueLists = null;
      message = t('hue.pairedNow');
      warn = false;
      break;
    }
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (result.code !== 'linkButton' || left <= 0) {
      message = result.code === 'linkButton' ? t('hue.timeout') : result.error;
      break;
    }
    renderHueSettings(t('hue.pressButton', { seconds: left }));
    await new Promise((resolve) => setTimeout(resolve, HUE_PAIR_RETRY_MS));
  }
  huePairing = false;
  renderHueSettings(message, warn);
}

// ---------- Phone ----------

// The QR code gives access to the deck: shown on demand only, and hidden again after a while
// (the editor may be on screen during a stream).
const QR_VISIBLE_MS = 2 * 60 * 1000;
let qrTimer = null;
let phonePoll = null;
let phoneUrl = '';
let phoneMax = null;

function renderPhone(status) {
  $('phone-enabled').checked = status.enabled;
  $('phone-details').hidden = !status.enabled;
  if (!status.enabled) return hideQr();
  $('phone-status').textContent = status.error || (status.url ? t('phone.ready', { url: status.url }) : t('phone.starting'));
  $('phone-status').classList.toggle('warn', Boolean(status.error));
  $('phone-phones').textContent = t('phone.phones', { count: status.phones });
  $('phone-max-hint').textContent = status.maxPhones
    ? t('phone.maxPhonesHint', { count: status.paired, max: status.maxPhones })
    : t('phone.maxPhonesNone');
  if (status.maxPhones !== phoneMax) {
    phoneMax = status.maxPhones;
    const choices = [1, 2, 3].map((n) => [n, String(n)]).concat([[0, t('phone.unlimited')]]);
    const picker = segmented(choices, phoneMax, async (max) => renderPhone(await api.setRemoteMaxPhones(max)));
    picker.id = 'phone-max';
    $('phone-max').replaceWith(picker);
  }
  $('phone-qr-toggle').disabled = !status.url;
  // New address (other network): the QR code shown points to the old one.
  if (status.url !== phoneUrl) hideQr();
  phoneUrl = status.url;
  $('phone-qr-toggle').textContent = t($('phone-qr').hidden ? 'phone.showQr' : 'phone.hideQr');
}

function hideQr() {
  clearTimeout(qrTimer);
  $('phone-qr').hidden = true;
  $('phone-qr-img').removeAttribute('src');
  $('phone-qr-toggle').textContent = t('phone.showQr');
}

async function toggleQr() {
  if (!$('phone-qr').hidden) return hideQr();
  const qr = await api.remoteQr();
  if (!qr) return;
  $('phone-qr-img').src = qr;
  $('phone-qr').hidden = false;
  $('phone-qr-toggle').textContent = t('phone.hideQr');
  clearTimeout(qrTimer);
  qrTimer = setTimeout(hideQr, QR_VISIBLE_MS);
}

async function refreshPhone() {
  // Minimized or behind other windows: nothing to keep up to date.
  if (document.hidden) return;
  try {
    renderPhone(await api.remoteStatus());
  } catch (err) {
    console.error('Phone status:', err);
  }
}

// The number of connected phones is kept up to date while the settings are on screen.
function watchPhone(visible) {
  clearInterval(phonePoll);
  phonePoll = null;
  if (!visible) return hideQr();
  refreshPhone();
  phonePoll = setInterval(refreshPhone, 5000);
}

document.addEventListener('visibilitychange', () => phonePoll && refreshPhone());

function setupPhone() {
  $('phone-enabled').addEventListener('change', async (e) => renderPhone(await api.setRemoteEnabled(e.target.checked)));
  $('phone-qr-toggle').addEventListener('click', toggleQr);
  $('phone-new-key').addEventListener('click', async () => {
    if (!(await confirmDialog(t('phone.newKeyConfirm'), t('phone.newKeyOk')))) return;
    const wasShown = !$('phone-qr').hidden;
    hideQr();
    renderPhone(await api.newRemoteKey());
    if (wasShown) toggleQr();
  });
}

function renderSettings() {
  renderDeckPosition();
  renderDeckScale();
  renderHotkey();
  renderConnectionForm();
  $('close-after').checked = config.closeAfterAction;
  $('close-outside').checked = config.closeOnClickOutside;
  $('login').checked = config.launchAtLogin;
  renderLightsSettings();
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
  resetHistory();
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
    // Pairing or unlinking the Hue bridge (Settings) changes what Hue keys can offer.
    if (next.hue?.paired !== config.hue?.paired) {
      config.hue = next.hue;
      hueLists = null;
      if (current().action.type === 'hue' || current().action.type === 'multi') renderActionFields();
    }
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
