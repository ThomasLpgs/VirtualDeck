const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const FORMAT = 'virtualdeck/backup';
const VERSION = 1;
const MEDIA_PREFIX = 'media:';
const MEDIA_ID = /^[a-f0-9]{16}$/;

// Bundles the config with the sounds and images it references, so the deck can be
// restored on another PC. Connection settings (and their secrets) are deliberately left out.
function exportBundle(cfg) {
  const media = {};
  const missing = [];
  const embed = (filePath) => {
    if (!filePath) return '';
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      missing.push(filePath);
      return '';
    }
    // Content hash: a file used by several buttons is stored once.
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    media[id] ??= { name: path.basename(filePath), data: data.toString('base64') };
    return MEDIA_PREFIX + id;
  };

  const buttons = cfg.buttons.map((button) => {
    const copy = structuredClone(button);
    copy.image = embed(copy.image);
    if (copy.action.type === 'sound') copy.action.file = embed(copy.action.file);
    for (const step of copy.action.type === 'multi' ? copy.action.steps || [] : []) {
      if (step.action?.type === 'sound') step.action.file = embed(step.action.file);
    }
    return copy;
  });

  const bundle = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    config: {
      hotkey: cfg.hotkey,
      closeAfterAction: cfg.closeAfterAction,
      closeOnClickOutside: cfg.closeOnClickOutside,
      grid: cfg.grid,
      pageCount: cfg.pageCount,
      pageGrids: cfg.pageGrids,
      pageNames: cfg.pageNames,
      buttons,
    },
    media,
  };
  return { bundle, missing };
}

function parseBundle(raw) {
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    bundle = null;
  }
  if (bundle?.format !== FORMAT || !Array.isArray(bundle.config?.buttons)) throw new Error(t('error.backupInvalid'));
  if (bundle.version > VERSION) throw new Error(t('error.backupTooNew'));
  return bundle;
}

// Writes the embedded media into mediaDir and returns the imported settings with real file paths.
function restoreBundle(bundle, mediaDir) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const written = new Map();
  const restore = (ref) => {
    // Our exports only hold embedded media. Any other path is dropped: a crafted file could
    // otherwise point at a network share (\\server\...) and leak Windows credentials on load.
    if (typeof ref !== 'string' || !ref.startsWith(MEDIA_PREFIX)) return '';
    const id = ref.slice(MEDIA_PREFIX.length);
    const item = bundle.media?.[id];
    if (!MEDIA_ID.test(id) || typeof item?.data !== 'string') return '';
    if (!written.has(id)) {
      // Never trust names from the file: no folders, no characters Windows rejects.
      const name = path.basename(String(item.name || 'media')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const target = path.join(mediaDir, `${id}-${name}`);
      fs.writeFileSync(target, Buffer.from(item.data, 'base64'));
      written.set(id, target);
    }
    return written.get(id);
  };

  const buttons = bundle.config.buttons.map((button) => {
    const copy = { ...button, action: { type: 'none', ...button?.action } };
    copy.image = restore(copy.image);
    if (copy.action.type === 'sound') copy.action.file = restore(copy.action.file);
    if (copy.action.type === 'multi' && Array.isArray(copy.action.steps)) {
      copy.action.steps = copy.action.steps.map((step) =>
        step?.action?.type === 'sound' ? { ...step, action: { ...step.action, file: restore(step.action.file) } } : step,
      );
    }
    return copy;
  });

  return {
    hotkey: bundle.config.hotkey,
    closeAfterAction: bundle.config.closeAfterAction,
    closeOnClickOutside: bundle.config.closeOnClickOutside,
    grid: bundle.config.grid,
    pageCount: bundle.config.pageCount,
    pageGrids: bundle.config.pageGrids,
    pageNames: bundle.config.pageNames,
    buttons,
  };
}

module.exports = { exportBundle, parseBundle, restoreBundle };
