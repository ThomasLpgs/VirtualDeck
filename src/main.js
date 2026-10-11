const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const i18n = require('./i18n');
const { ObsManager } = require('./obs');
const { StreamlabsManager } = require('./streamlabs');
const { runAction } = require('./actions');
const backup = require('./backup');
const { checkForUpdate } = require('./updates');

const { t } = i18n;

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
// Must match "build.appId" in package.json, or Windows notifications won't show in the installed app.
const APP_ID = 'com.virtualdeck.app';
const LUCIDE_DIR = path.join(__dirname, '..', 'node_modules', 'lucide-static');
const BACKUP_EXT = 'vdeck';
// Shape of the hotkeys the editor records: modifiers + a key, or a lone function key.
// Anything else in an imported file is ignored, so it can't grab Ctrl+C or Alt+Tab system-wide.
const IMPORTABLE_HOTKEY = /^(?:(?:Control|Alt|Shift|Super)\+)+[A-Za-z0-9]+$|^F\d{1,2}$/;
// Must match the CSS variables in shared/keys.css and the body padding in deck/deck.css.
const KEY_SIZE = 88;
const KEY_GAP = 10;
const PANEL_PADDING = 14;
const HEADER_HEIGHT = 34;
const SHADOW_MARGIN = 24;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

const FILE_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'],
  sound: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  program: ['exe', 'lnk', 'bat', 'cmd'],
};

// Sounds are triggered from a click in the deck, but may also be played while it is hidden.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Pin the config folder so the installed app and `npm start` share the same buttons.
// Only when untouched, so test runs can still point userData elsewhere.
if (app.getPath('userData') === path.join(app.getPath('appData'), app.getName())) {
  app.setPath('userData', path.join(app.getPath('appData'), 'VirtualDeck'));
}

let cfg;
let deckWin = null;
// Page shown by the deck (0-based). Not saved: the deck starts on the first page.
let deckPage = 0;
// Where showDeck() last put the deck, to tell its own moves from the user's drags.
let placedAt = null;
// While the corner grip is dragged: the scale shown (saved on release) and where the drag began.
let liveScale = null;
let resizeStart = null;
let editorWin = null;
let tray = null;
// { version, url } of a newer GitHub release, once one has been found.
let update = null;
const streams = { obs: new ObsManager(), streamlabs: new StreamlabsManager() };
const activeStream = () => streams[cfg.software];

const fileUrl = (p) => (p ? pathToFileURL(p).href : '');

// Our pages never navigate or open windows: block it so nothing can replace them with remote content.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
});

// Renderers can't build file:// URLs themselves (sandboxed preload), so add them here.
function forRenderer(c) {
  return { ...c, buttons: c.buttons.map((b) => ({ ...b, imageUrl: fileUrl(b.image) })) };
}

// Ctrl+C, Ctrl+V… would stop working in every other app.
const RESERVED_HOTKEYS = ['Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+A', 'Control+S', 'Alt+Tab', 'Alt+F4'];

function isImportableHotkey(hotkey) {
  return typeof hotkey === 'string' && IMPORTABLE_HOTKEY.test(hotkey) && !RESERVED_HOTKEYS.includes(hotkey);
}

function streamState() {
  return { ...activeStream().state, software: cfg.software, label: activeStream().label };
}

function broadcast(channel, data) {
  for (const win of [deckWin, editorWin]) {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(channel, data);
  }
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: t('app.name'), body }).show();
}

// ---------- Updates ----------

function openUpdatePage() {
  if (update) shell.openExternal(update.url);
}

async function checkUpdates() {
  const found = await checkForUpdate(app.getVersion());
  if (!found) return;
  update = found;
  updateTray();
  broadcast('update:available', update);
}

function applyLanguage() {
  return i18n.setLanguage(i18n.resolveLanguage(cfg.language, app.getPreferredSystemLanguages()));
}

// Connects the selected streaming software and disconnects the other one.
function activateStream() {
  for (const [name, client] of Object.entries(streams)) {
    if (name === cfg.software) client.configure(cfg[name]);
    else if (client.settings) client.stop();
  }
  broadcast('stream:state', streamState());
}

// ---------- Deck window ----------

// The deck page is scaled with CSS zoom (deck.js), so the whole window scales with it.
function deckSize() {
  const { cols, rows } = cfg.grid;
  const scale = liveScale ?? cfg.deckScale;
  return {
    width: Math.round(scale * (cols * KEY_SIZE + (cols - 1) * KEY_GAP + 2 * PANEL_PADDING + 2 * SHADOW_MARGIN)),
    height: Math.round(scale * (HEADER_HEIGHT + rows * KEY_SIZE + (rows - 1) * KEY_GAP + PANEL_PADDING + 2 * SHADOW_MARGIN)),
  };
}

// Resizes the open deck around its top-left corner.
function resizeDeckWindow() {
  if (!deckWin || deckWin.isDestroyed()) return;
  const [x, y] = deckWin.getPosition();
  placedAt = { x, y };
  deckWin.setBounds({ x, y, ...deckSize() });
}

function saveDeckScale(deckScale) {
  liveScale = null;
  cfg = config.save({ ...cfg, deckScale });
  if (deckWin.isVisible()) resizeDeckWindow();
  broadcast('config:changed', forRenderer(cfg));
}

// Corner grip of the deck: the scale follows the mouse, measured here in screen pixels.
function onDeckResize(phase) {
  if (phase === 'start') {
    resizeStart = { cursor: screen.getCursorScreenPoint(), scale: cfg.deckScale, size: deckSize() };
    return;
  }
  if (!resizeStart) return;
  if (phase === 'end') {
    const scale = liveScale ?? resizeStart.scale;
    resizeStart = null;
    saveDeckScale(scale);
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const { size } = resizeStart;
  // Whichever direction moved the most, so dragging along either edge works.
  const ratio = Math.max(
    (size.width + cursor.x - resizeStart.cursor.x) / size.width,
    (size.height + cursor.y - resizeStart.cursor.y) / size.height,
  );
  const scale = Math.min(config.MAX_DECK_SCALE, Math.max(config.MIN_DECK_SCALE, resizeStart.scale * ratio));
  liveScale = Math.round(scale * 100) / 100;
  deckWin.webContents.send('deck:scale', liveScale);
  resizeDeckWindow();
}

function createDeckWindow() {
  deckWin = new BrowserWindow({
    ...deckSize(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    // Dragged by its header (see deck.css).
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // Stay above borderless-fullscreen games and OBS projectors.
  deckWin.setAlwaysOnTop(true, 'screen-saver');
  deckWin.loadFile(path.join(__dirname, 'deck', 'index.html'));
  // Also after the reload that follows a language change.
  deckWin.webContents.on('did-finish-load', () => deckWin.webContents.send('deck:page', deckPage));
  deckWin.on('blur', hideDeck);
  deckWin.on('moved', () => {
    const [x, y] = deckWin.getPosition();
    if (placedAt && placedAt.x === x && placedAt.y === y) return;
    placedAt = { x, y };
    saveDeckPosition({ x, y });
  });
}

// The position is owned here, not by the editor: it is saved without going through applyConfig.
function saveDeckPosition(deckPosition) {
  cfg = config.save({ ...cfg, deckPosition });
  broadcast('config:changed', forRenderer(cfg));
}

function showDeck() {
  const { width, height } = deckSize();
  // Where the user dragged it last, otherwise centered under the mouse.
  const saved = cfg.deckPosition;
  const cursor = screen.getCursorScreenPoint();
  const wanted = saved || { x: Math.round(cursor.x - width / 2), y: Math.round(cursor.y - height / 2) };
  // A saved spot may be on a screen that has since been unplugged: the nearest screen takes it.
  const area = screen.getDisplayNearestPoint(saved ? { x: saved.x + width / 2, y: saved.y + height / 2 } : cursor).workArea;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  // The shadow margin may overflow the screen edge; only the panel itself must stay visible.
  placedAt = {
    x: clamp(wanted.x, area.x - SHADOW_MARGIN, area.x + area.width - width + SHADOW_MARGIN),
    y: clamp(wanted.y, area.y - SHADOW_MARGIN, area.y + area.height - height + SHADOW_MARGIN),
  };
  deckWin.setBounds({ ...placedAt, width, height });
  deckWin.webContents.send('deck:show');
  deckWin.show();
  deckWin.focus();
}

// target: 'next' / 'prev' (wrapping around) or a page number (1-based).
function goToPage(target) {
  const count = cfg.pageCount;
  if (target === 'next') deckPage = (deckPage + 1) % count;
  else if (target === 'prev') deckPage = (deckPage - 1 + count) % count;
  else deckPage = Math.min(count, Math.max(1, Number(target) || 1)) - 1;
  deckWin.webContents.send('deck:page', deckPage);
}

function hideDeck() {
  if (!deckWin || deckWin.isDestroyed() || !deckWin.isVisible()) return;
  deckWin.hide();
  // The page stays loaded (instant opening): tell it to stop refreshing what nobody sees.
  deckWin.webContents.send('deck:hidden');
}

function toggleDeck() {
  if (deckWin.isVisible()) hideDeck();
  else showDeck();
}

function playSound(file, volume) {
  deckWin.webContents.send('audio:toggle', { url: fileUrl(file), volume });
}

// ---------- Editor window ----------

// buttonIndex (optional): button to select in the editor, e.g. when an empty "+" key is clicked.
function openEditor(buttonIndex) {
  const selectButton = () => {
    if (Number.isInteger(buttonIndex)) editorWin.webContents.send('editor:select', buttonIndex);
  };
  if (editorWin && !editorWin.isDestroyed()) {
    if (editorWin.isMinimized()) editorWin.restore();
    editorWin.show();
    editorWin.focus();
    selectButton();
    return;
  }
  editorWin = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: t('editor.windowTitle'),
    icon: APP_ICON,
    backgroundColor: '#0e0f12',
    autoHideMenuBar: true,
    // Custom dark title bar that keeps the native Windows controls.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f12', symbolColor: '#a1a3ad', height: 52 },
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  editorWin.webContents.once('did-finish-load', selectButton);
  editorWin.loadFile(path.join(__dirname, 'editor', 'index.html'));
  editorWin.on('closed', () => {
    editorWin = null;
    registerHotkey();
  });
}

// ---------- Hotkey & tray ----------

// Keys whose own hotkey couldn't be registered (taken by another app, the deck or another key).
let failedKeyHotkeys = [];

// Registers the deck hotkey and the hotkey of each key. Returns whether the deck hotkey worked.
function registerHotkey() {
  globalShortcut.unregisterAll();
  const register = (accelerator, callback) => {
    try {
      return globalShortcut.register(accelerator, callback);
    } catch {
      return false;
    }
  };
  const deckOk = cfg.hotkey ? register(cfg.hotkey, toggleDeck) : false;
  failedKeyHotkeys = [];
  const used = new Set([cfg.hotkey]);
  const perPage = cfg.grid.cols * cfg.grid.rows;
  cfg.buttons.forEach((button, index) => {
    // Only keys that can be seen in the deck: within the grid, on an existing page.
    if (index % config.PAGE_SIZE >= perPage || index >= cfg.pageCount * config.PAGE_SIZE) return;
    if (!button.hotkey || button.action.type === 'none') return;
    if (used.has(button.hotkey) || !register(button.hotkey, () => runKey(index))) failedKeyHotkeys.push(index);
    used.add(button.hotkey);
  });
  return deckOk;
}

// Runs a key, from the deck or from its own hotkey. When the deck isn't on screen (closed after
// the action, or never opened), errors and confirmations are shown as notifications.
async function runKey(index, { fromDeck = false } = {}) {
  const button = cfg.buttons[index];
  if (!button) return { ok: false, error: t('error.buttonNotFound') };
  // A page key changes what the deck shows: it must not close it.
  const closes = fromDeck && cfg.closeAfterAction && button.action.type !== 'page';
  if (closes) hideDeck();
  const unseen = !fromDeck || closes;
  try {
    const result = await runAction(button.action, { stream: activeStream(), playSound });
    if (result?.page) {
      goToPage(result.page);
      // From a hotkey (or after the deck closed), open the deck on that page.
      if (!deckWin.isVisible()) showDeck();
    }
    if (unseen && result?.notice) notify(result.notice);
    return { ok: true, warning: result?.warning, notice: result?.notice };
  } catch (err) {
    if (unseen) notify(err.message);
    return { ok: false, error: err.message };
  }
}

function updateTray() {
  tray.setToolTip(`${t('app.name')} (${cfg.hotkey})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(update
        ? [{ label: t('update.tray', { version: update.version }), click: openUpdatePage }, { type: 'separator' }]
        : []),
      { label: t('tray.open'), click: showDeck },
      { label: t('tray.configure'), click: () => openEditor() },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(APP_ICON).resize({ width: 32, height: 32, quality: 'best' }));
  updateTray();
  tray.on('click', () => openEditor());
}

// ---------- Config ----------

// Persists a new config and applies it everywhere. Returns whether the hotkey could be registered.
function applyConfig(next) {
  const previousLanguage = i18n.bundle().lang;
  cfg = config.save(next);
  if (deckPage >= cfg.pageCount) goToPage(1);
  const hotkeyOk = registerHotkey();
  app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin });
  activateStream();

  if (applyLanguage() !== previousLanguage) {
    // Simplest way to retranslate everything: reload the pages (the config is already saved).
    updateTray();
    for (const win of [deckWin, editorWin]) if (win && !win.isDestroyed()) win.webContents.reload();
    if (editorWin && !editorWin.isDestroyed()) editorWin.setTitle(t('editor.windowTitle'));
  } else {
    updateTray();
    broadcast('config:changed', forRenderer(cfg));
  }
  return hotkeyOk;
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('config:get', () => forRenderer(cfg));
  ipcMain.handle('i18n:get', () => i18n.bundle());

  ipcMain.handle('config:save', (_e, next) => {
    try {
      // Position and size are set from the deck itself (see saveDeckPosition / saveDeckScale).
      const hotkeyOk = applyConfig({ ...next, deckPosition: cfg.deckPosition, deckScale: cfg.deckScale });
      return { ok: true, hotkeyOk, failedKeyHotkeys };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('config:export', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(editorWin, {
      title: t('backup.exportTitle'),
      defaultPath: path.join(app.getPath('documents'), `${t('app.name')} ${date}.${BACKUP_EXT}`),
      filters: [{ name: t('backup.fileType', { app: t('app.name') }), extensions: [BACKUP_EXT] }],
    });
    if (canceled || !filePath) return null;
    try {
      const { bundle, missing } = backup.exportBundle(cfg);
      fs.writeFileSync(filePath, JSON.stringify(bundle));
      return { ok: true, path: filePath, missing };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('config:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(editorWin, {
      title: t('backup.importTitle'),
      properties: ['openFile'],
      filters: [{ name: t('backup.fileType', { app: t('app.name') }), extensions: [BACKUP_EXT] }],
    });
    if (canceled || !filePaths[0]) return null;

    let bundle;
    try {
      bundle = backup.parseBundle(fs.readFileSync(filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // An imported deck may come from someone else: point out buttons that launch things.
    const opens = (action) =>
      action?.type === 'open' ? 1 : (Array.isArray(action?.steps) ? action.steps : []).filter((s) => s?.action?.type === 'open').length;
    const openCount = bundle.config.buttons.reduce((count, b) => count + opens(b?.action), 0);
    const { response } = await dialog.showMessageBox(editorWin, {
      type: 'question',
      buttons: [t('backup.importConfirm'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: t('backup.importTitle'),
      message: t('backup.importQuestion', { file: path.basename(filePaths[0]) }),
      detail: t('backup.importDetail') + (openCount ? `\n\n${t('backup.importOpenWarning', { count: openCount })}` : ''),
    });
    if (response !== 0) return null;

    try {
      const imported = backup.restoreBundle(bundle, path.join(app.getPath('userData'), 'media'));
      const hotkeyOk = applyConfig({
        ...cfg,
        hotkey: isImportableHotkey(imported.hotkey) ? imported.hotkey : cfg.hotkey,
        closeAfterAction: imported.closeAfterAction !== false,
        grid: imported.grid,
        pageCount: imported.pageCount,
        // Same rule as the deck hotkey: an imported key can't grab Ctrl+C or Alt+Tab system-wide.
        buttons: imported.buttons.map((b) => (isImportableHotkey(b?.hotkey) ? b : { ...b, hotkey: '' })),
      });
      return { ok: true, hotkeyOk, config: forRenderer(cfg), buttonCount: imported.buttons.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('deck:press', (_e, index) => runKey(index, { fromDeck: true }));

  ipcMain.on('deck:hide', hideDeck);
  ipcMain.on('deck:resetPosition', () => saveDeckPosition(null));
  ipcMain.on('deck:turnPage', (_e, delta) => goToPage(delta < 0 ? 'prev' : 'next'));
  ipcMain.on('deck:resize', (_e, phase) => onDeckResize(phase));
  ipcMain.on('deck:setScale', (_e, scale) => {
    if (Number.isFinite(scale)) saveDeckScale(Math.min(config.MAX_DECK_SCALE, Math.max(config.MIN_DECK_SCALE, scale)));
  });
  ipcMain.on('editor:open', (_e, buttonIndex) => {
    hideDeck();
    openEditor(buttonIndex);
  });

  // The editor's hotkey field needs to receive the combo instead of the global shortcut.
  ipcMain.on('hotkey:pause', (_e, paused) => {
    if (paused) globalShortcut.unregisterAll();
    else registerHotkey();
  });

  ipcMain.handle('dialog:pick', async (_e, kind) => {
    const filters = FILE_EXTENSIONS[kind] ? [{ name: t(`file.${kind}`), extensions: FILE_EXTENSIONS[kind] }] : [];
    if (kind === 'program') filters.push({ name: t('file.all'), extensions: ['*'] });
    const { canceled, filePaths } = await dialog.showOpenDialog(editorWin, { properties: ['openFile'], filters });
    if (canceled || !filePaths[0]) return null;
    return { path: filePaths[0], url: fileUrl(filePaths[0]) };
  });

  // About 1,600 icons: read once, then kept for the next times the editor opens.
  let icons = null;
  ipcMain.handle('icons:list', () => {
    if (icons) return icons;
    const names = fs
      .readdirSync(path.join(LUCIDE_DIR, 'icons'))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4));
    const tags = JSON.parse(fs.readFileSync(path.join(LUCIDE_DIR, 'tags.json'), 'utf8'));
    icons = { names, tags };
    return icons;
  });

  ipcMain.handle('update:get', () => update);
  ipcMain.on('update:open', openUpdatePage);

  ipcMain.handle('stream:state', () => streamState());
  ipcMain.handle('stream:reconnect', () => activeStream().reconnect());
  ipcMain.handle('stream:scenes', () => activeStream().getScenes().catch(() => []));
  ipcMain.handle('stream:inputs', () => activeStream().getAudioInputs().catch(() => []));
  ipcMain.handle('stream:verticalScenes', () => activeStream().getVerticalScenes().catch(() => []));
  ipcMain.handle('stream:sources', (_e, scene, vertical) =>
    activeStream().getSources(scene, { vertical: vertical === true }).catch(() => []),
  );

  for (const client of Object.values(streams)) {
    client.on('state', () => {
      if (client === activeStream()) broadcast('stream:state', streamState());
    });
  }
}

// ---------- Startup ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching the app a second time opens the editor instead of a duplicate.
  app.on('second-instance', () => openEditor());
  // Tray app: closing the editor must not quit.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    const loaded = config.load();
    cfg = loaded.config;
    applyLanguage();
    // Keeps the startup entry pointing at the current exe, e.g. after a reinstall elsewhere.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin });

    registerIpc();
    createDeckWindow();
    createTray();
    activateStream();

    // A short delay keeps the check off the startup path (the app may start with Windows, before the network).
    setTimeout(checkUpdates, 15000);
    setInterval(checkUpdates, UPDATE_CHECK_MS);

    const hotkeyOk = registerHotkey();
    if (loaded.firstRun) {
      openEditor();
    } else if (!hotkeyOk) {
      notify(t('notify.hotkeyTaken', { hotkey: cfg.hotkey }));
      openEditor();
    }
  });
}
