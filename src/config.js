const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_COLS = 8;
const MAX_ROWS = 6;
const DEFAULT_COLOR = '#8b8d98';
// Dark grey used as the key background by v0.1; the color is now an accent and would be invisible.
const LEGACY_DEFAULT_COLOR = '#2a2f3a';

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function defaultButton() {
  return {
    id: crypto.randomUUID(),
    label: '',
    symbol: '',
    icon: '',
    image: '',
    color: DEFAULT_COLOR,
    action: { type: 'none' },
  };
}

function defaults() {
  return {
    hotkey: 'Control+Shift+Space',
    closeAfterAction: true,
    launchAtLogin: false,
    grid: { cols: 3, rows: 2 },
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    buttons: Array.from({ length: 6 }, defaultButton),
  };
}

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
  cfg.obs = { ...base.obs, ...raw?.obs };
  cfg.closeAfterAction = cfg.closeAfterAction !== false;
  cfg.launchAtLogin = cfg.launchAtLogin === true;

  const buttons = Array.isArray(raw?.buttons) ? raw.buttons : [];
  cfg.buttons = buttons.map((b) => {
    const { imageUrl, ...rest } = b || {};
    const button = { ...defaultButton(), ...rest, action: { type: 'none', ...rest.action } };
    if (button.color === LEGACY_DEFAULT_COLOR) button.color = DEFAULT_COLOR;
    return button;
  });
  while (cfg.buttons.length < cfg.grid.cols * cfg.grid.rows) cfg.buttons.push(defaultButton());
  return cfg;
}

function encryptPassword(password) {
  if (!password || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(password).toString('base64');
}

function decryptPassword(obs) {
  if (!obs?.passwordEnc) return obs?.password || '';
  try {
    return safeStorage.decryptString(Buffer.from(obs.passwordEnc, 'base64'));
  } catch {
    return '';
  }
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Config illisible, valeurs par défaut utilisées :', err);
    return { config: defaults(), firstRun: err.code === 'ENOENT' };
  }
  raw.obs = { ...raw.obs, password: decryptPassword(raw.obs) };
  delete raw.obs.passwordEnc;
  return { config: normalize(raw), firstRun: false };
}

function save(next) {
  const cfg = normalize(next);
  const onDisk = structuredClone(cfg);
  const enc = encryptPassword(cfg.obs.password);
  if (enc) {
    onDisk.obs.passwordEnc = enc;
    delete onDisk.obs.password;
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(onDisk, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return cfg;
}

module.exports = { load, save, normalize, defaultButton, configPath };
