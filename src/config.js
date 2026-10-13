const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_COLS = 8;
const MAX_ROWS = 6;
// Pages of keys. Page p holds buttons[p * PAGE_SIZE ...]: one slot per possible grid cell, so
// resizing the grid never moves a key to another page. Must match PAGE_SIZE in shared/keys.js.
const PAGE_SIZE = MAX_COLS * MAX_ROWS;
const MAX_PAGES = 10;
const MAX_PAGE_NAME = 30;
// Phones allowed to use the deck at most (the setting offers 1 to 3, or no limit = 0).
const MAX_PHONES = 10;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
// Size of the deck relative to its default size (1 = 100 %).
const MIN_DECK_SCALE = 0.6;
const MAX_DECK_SCALE = 1.6;
const DEFAULT_COLOR = '#8b8d98';
const SOFTWARES = ['obs', 'streamlabs'];

// Secret field of each settings section (streaming software, phone pairing key, Hue bridge key),
// stored encrypted on disk.
const SECRETS = { obs: 'password', streamlabs: 'token', remote: 'key', hue: 'key' };

const configPath = () => path.join(app.getPath('userData'), 'config.json');

// The config as last read or written, to skip writing the disk when nothing changed. Compared
// before encryption: an encrypted password differs on every call even when it is the same.
let lastSaved = null;

function defaultButton() {
  return {
    id: crypto.randomUUID(),
    label: '',
    symbol: '',
    icon: '',
    image: '',
    color: DEFAULT_COLOR,
    // Global hotkey running this key without opening the deck ('' for none).
    hotkey: '',
    action: { type: 'none' },
  };
}

function defaults() {
  return {
    language: 'auto',
    hotkey: 'Control+Shift+Space',
    closeAfterAction: true,
    // A click anywhere else closes the deck.
    closeOnClickOutside: true,
    launchAtLogin: false,
    grid: { cols: 3, rows: 2 },
    pageCount: 1,
    // Name of each page ('' shows "Page n").
    pageNames: [''],
    // How page keys show a page: 'replace' the deck's grid, or 'popup' a deck over it.
    pageMode: 'replace',
    // Top-left corner where the user dragged the deck, or null to open it under the mouse.
    deckPosition: null,
    deckScale: 1,
    software: 'obs',
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    streamlabs: { url: 'ws://127.0.0.1:59650/api/websocket', token: '' },
    // Phone as a deck (remote.js): off by default. port 0 = not chosen yet; key = pairing key;
    // maxPhones = how many devices may use it (0 = no limit); devices = ids of those that did.
    remote: { enabled: false, port: 0, key: '', maxPhones: 1, devices: [] },
    // Paired Philips Hue bridge (hue.js): its address, id, name, certificate fingerprint and key.
    hue: { ip: '', id: '', name: '', cert: '', key: '' },
    // Connected lights turned on in the settings: while off, nothing is ever sent to them.
    lights: { hue: false, govee: false },
    buttons: Array.from({ length: 6 }, defaultButton),
  };
}

// Steps of a multi-action: { delay (seconds), action }. No multi-action inside a multi-action.
function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step?.action && typeof step.action === 'object' && typeof step.action.type === 'string')
    .filter((step) => step.action.type !== 'multi')
    .map((step) => ({ delay: clamp(step.delay, 0, 600, 0), action: { ...step.action } }));
}

// Grid ({ cols, rows }) of a page (0-based).
const gridOf = (cfg, page) => cfg.pageGrids?.[page] || cfg.grid;

const clamp = (n, min, max, fallback) =>
  Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Math.round(Number(n)))) : fallback;

// Fills in missing fields so the rest of the app can trust the shape.
// Extra buttons beyond the grid size are kept so shrinking the grid is not destructive.
function normalize(raw) {
  const base = defaults();
  const cfg = { ...base, ...raw };
  cfg.grid = {
    cols: clamp(raw?.grid?.cols, 1, MAX_COLS, base.grid.cols),
    rows: clamp(raw?.grid?.rows, 1, MAX_ROWS, base.grid.rows),
  };
  cfg.software = SOFTWARES.includes(raw?.software) ? raw.software : base.software;
  for (const software of SOFTWARES) cfg[software] = { ...base[software], ...raw?.[software] };
  cfg.language = typeof raw?.language === 'string' ? raw.language : base.language;
  cfg.hotkey = typeof raw?.hotkey === 'string' ? raw.hotkey : base.hotkey;
  const pos = raw?.deckPosition;
  cfg.deckPosition =
    pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null;
  const scale = Number(raw?.deckScale);
  cfg.deckScale = Number.isFinite(scale) ? Math.min(MAX_DECK_SCALE, Math.max(MIN_DECK_SCALE, scale)) : base.deckScale;
  cfg.closeAfterAction = cfg.closeAfterAction !== false;
  cfg.closeOnClickOutside = cfg.closeOnClickOutside !== false;
  cfg.remote = {
    enabled: raw?.remote?.enabled === true,
    port: clamp(raw?.remote?.port, 0, 65535, 0),
    key: /^[A-Za-z0-9_-]{43}$/.test(raw?.remote?.key) ? raw.remote.key : '',
    maxPhones: clamp(raw?.remote?.maxPhones, 0, MAX_PHONES, base.remote.maxPhones),
    devices: [],
  };
  const devices = Array.isArray(raw?.remote?.devices) ? raw.remote.devices : [];
  cfg.remote.devices = [...new Set(devices.filter((id) => typeof id === 'string' && DEVICE_ID.test(id)))].slice(
    0,
    cfg.remote.maxPhones || MAX_PHONES,
  );
  const hue = raw?.hue && typeof raw.hue === 'object' ? raw.hue : {};
  const matching = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : '');
  cfg.hue = {
    ip: matching(hue.ip, /^\d{1,3}(\.\d{1,3}){3}$/),
    id: matching(hue.id, /^[0-9a-f]{16}$/),
    name: typeof hue.name === 'string' ? hue.name.slice(0, 60) : '',
    cert: matching(hue.cert, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/),
    key: matching(hue.key, /^[A-Za-z0-9_-]{20,64}$/),
  };
  // A Hue bridge paired before this setting existed stays on.
  const lights = raw?.lights && typeof raw.lights === 'object' ? raw.lights : {};
  cfg.lights = {
    hue: typeof lights.hue === 'boolean' ? lights.hue : Boolean(cfg.hue.key),
    govee: lights.govee === true,
  };
  cfg.launchAtLogin = cfg.launchAtLogin === true;

  const buttons = Array.isArray(raw?.buttons) ? raw.buttons : [];
  cfg.buttons = buttons.map((b) => {
    const { imageUrl, ...rest } = b && typeof b === 'object' ? b : {};
    const action = rest.action && typeof rest.action === 'object' ? rest.action : {};
    const button = { ...defaultButton(), ...rest, action: { type: 'none', ...action } };
    // The renderers call string methods on these: never let a hand-edited or imported file break them.
    for (const field of ['id', 'label', 'symbol', 'icon', 'image', 'color', 'hotkey']) {
      if (typeof button[field] !== 'string') button[field] = defaultButton()[field];
    }
    if (typeof button.action.type !== 'string') button.action.type = 'none';
    if (button.action.type === 'multi') button.action.steps = normalizeSteps(button.action.steps);
    return button;
  });
  cfg.pageCount = clamp(raw?.pageCount, 1, MAX_PAGES, base.pageCount);
  cfg.pageMode = raw?.pageMode === 'popup' ? 'popup' : 'replace';
  // Each page has its own grid. Page 1's is also `grid` (configs and backups from before
  // per-page grids only have that one, and every page then starts with it).
  const grids = Array.isArray(raw?.pageGrids) ? raw.pageGrids : [];
  cfg.pageGrids = Array.from({ length: cfg.pageCount }, (_, p) => ({
    cols: clamp(grids[p]?.cols, 1, MAX_COLS, cfg.grid.cols),
    rows: clamp(grids[p]?.rows, 1, MAX_ROWS, cfg.grid.rows),
  }));
  cfg.grid = { ...cfg.pageGrids[0] };
  const names = Array.isArray(raw?.pageNames) ? raw.pageNames : [];
  cfg.pageNames = Array.from({ length: cfg.pageCount }, (_, p) =>
    typeof names[p] === 'string' ? names[p].trim().slice(0, MAX_PAGE_NAME) : '',
  );
  // Every page but the last is full, so a page always starts at its own PAGE_SIZE boundary.
  const last = cfg.pageGrids[cfg.pageCount - 1];
  const needed = (cfg.pageCount - 1) * PAGE_SIZE + last.cols * last.rows;
  while (cfg.buttons.length < needed) cfg.buttons.push(defaultButton());
  return cfg;
}

function encrypt(secret) {
  if (!secret || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(secret).toString('base64');
}

function decrypt(encrypted) {
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return '';
  }
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Unreadable config, using defaults:', err);
    return { config: defaults(), firstRun: err.code === 'ENOENT' };
  }
  for (const [software, field] of Object.entries(SECRETS)) {
    const settings = raw[software];
    if (!settings?.[`${field}Enc`]) continue;
    settings[field] = decrypt(settings[`${field}Enc`]);
    delete settings[`${field}Enc`];
  }
  const config = normalize(raw);
  lastSaved = JSON.stringify(config);
  return { config, firstRun: false };
}

function save(next) {
  const cfg = normalize(next);
  const text = JSON.stringify(cfg);
  if (text === lastSaved) return cfg;
  const onDisk = structuredClone(cfg);
  for (const [software, field] of Object.entries(SECRETS)) {
    const enc = encrypt(cfg[software][field]);
    if (!enc) continue;
    onDisk[software][`${field}Enc`] = enc;
    delete onDisk[software][field];
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(onDisk, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  lastSaved = text;
  return cfg;
}

module.exports = {
  load,
  save,
  normalize,
  defaultButton,
  configPath,
  SOFTWARES,
  MIN_DECK_SCALE,
  MAX_DECK_SCALE,
  PAGE_SIZE,
  gridOf,
};
