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

const { t } = i18n;

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
// Must match "build.appId" in package.json, or Windows notifications won't show in the installed app.
const APP_ID = 'com.virtualdeck.app';
const LUCIDE_DIR = path.join(__dirname, '..', 'node_modules', 'lucide-static');
const BACKUP_EXT = 'vdeck';
// Backups made before the rename used .svdeck.
const BACKUP_IMPORT_EXTS = ['vdeck', 'svdeck'];
// Must match the CSS variables in shared/keys.css and the body padding in deck/deck.css.
const KEY_SIZE = 88;
const KEY_GAP = 10;
const PANEL_PADDING = 14;
const HEADER_HEIGHT = 34;
const SHADOW_MARGIN = 24;

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
  migrateLegacyUserData();
}

// Before the rename, the config lived in %APPDATA%\streamdeck-virtuel. Copies what matters:
// the config, the imported media, and "Local State", which holds the key that encrypts the
// connection password. The old folder is left as is.
function migrateLegacyUserData() {
  const appData = app.getPath('appData');
  const from = path.join(appData, 'streamdeck-virtuel');
  const to = app.getPath('userData');
  if (fs.existsSync(path.join(to, 'config.json')) || !fs.existsSync(path.join(from, 'config.json'))) return;
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of ['Local State', 'media']) {
      if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
    }
    // Imported media are referenced by absolute path.
    const escaped = (dir) => JSON.stringify(dir + path.sep).slice(1, -1);
    const raw = fs.readFileSync(path.join(from, 'config.json'), 'utf8');
    fs.writeFileSync(path.join(to, 'config.json'), raw.split(escaped(from)).join(escaped(to)));
  } catch (err) {
    console.error('Migration of the old config folder failed:', err);
  }
}

let cfg;
let deckWin = null;
let editorWin = null;
let tray = null;
const streams = { obs: new ObsManager(), streamlabs: new StreamlabsManager() };
const activeStream = () => streams[cfg.software];

const fileUrl = (p) => (p ? pathToFileURL(p).href : '');

// Renderers can't build file:// URLs themselves (sandboxed preload), so add them here.
function forRenderer(c) {
  return { ...c, buttons: c.buttons.map((b) => ({ ...b, imageUrl: fileUrl(b.image) })) };
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

function deckSize() {
  const { cols, rows } = cfg.grid;
  return {
    width: cols * KEY_SIZE + (cols - 1) * KEY_GAP + 2 * PANEL_PADDING + 2 * SHADOW_MARGIN,
    height: HEADER_HEIGHT + rows * KEY_SIZE + (rows - 1) * KEY_GAP + PANEL_PADDING + 2 * SHADOW_MARGIN,
  };
}

function createDeckWindow() {
  deckWin = new BrowserWindow({
    ...deckSize(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
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
  deckWin.on('blur', hideDeck);
}

function showDeck() {
  const { width, height } = deckSize();
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  // The shadow margin may overflow the screen edge; only the panel itself must stay visible.
  deckWin.setBounds({
    x: clamp(Math.round(cursor.x - width / 2), area.x - SHADOW_MARGIN, area.x + area.width - width + SHADOW_MARGIN),
    y: clamp(Math.round(cursor.y - height / 2), area.y - SHADOW_MARGIN, area.y + area.height - height + SHADOW_MARGIN),
    width,
    height,
  });
  deckWin.webContents.send('deck:show');
  deckWin.show();
  deckWin.focus();
}

function hideDeck() {
  if (deckWin && !deckWin.isDestroyed() && deckWin.isVisible()) deckWin.hide();
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

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!cfg.hotkey) return false;
  try {
    return globalShortcut.register(cfg.hotkey, toggleDeck);
  } catch {
    return false;
  }
}

function updateTray() {
  tray.setToolTip(`${t('app.name')} (${cfg.hotkey})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
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
      return { ok: true, hotkeyOk: applyConfig(next) };
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
      filters: [{ name: t('backup.fileType', { app: t('app.name') }), extensions: BACKUP_IMPORT_EXTS }],
    });
    if (canceled || !filePaths[0]) return null;

    let bundle;
    try {
      bundle = backup.parseBundle(fs.readFileSync(filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // An imported deck may come from someone else: point out buttons that launch things.
    const openCount = bundle.config.buttons.filter((b) => b?.action?.type === 'open').length;
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
        hotkey: imported.hotkey || cfg.hotkey,
        closeAfterAction: imported.closeAfterAction,
        grid: imported.grid,
        buttons: imported.buttons,
      });
      return { ok: true, hotkeyOk, config: forRenderer(cfg), buttonCount: imported.buttons.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('deck:press', async (_e, index) => {
    const button = cfg.buttons[index];
    if (!button) return { ok: false, error: t('error.buttonNotFound') };
    if (cfg.closeAfterAction) hideDeck();
    try {
      await runAction(button.action, { stream: activeStream(), playSound });
      return { ok: true };
    } catch (err) {
      if (cfg.closeAfterAction) notify(err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('deck:hide', hideDeck);
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

  ipcMain.handle('icons:list', () => {
    const names = fs
      .readdirSync(path.join(LUCIDE_DIR, 'icons'))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4));
    const tags = JSON.parse(fs.readFileSync(path.join(LUCIDE_DIR, 'tags.json'), 'utf8'));
    return { names, tags };
  });

  ipcMain.handle('stream:state', () => streamState());
  ipcMain.handle('stream:reconnect', () => activeStream().reconnect());
  ipcMain.handle('stream:scenes', () => activeStream().getScenes().catch(() => []));
  ipcMain.handle('stream:sources', (_e, scene) => activeStream().getSources(scene).catch(() => []));

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

    const hotkeyOk = registerHotkey();
    if (loaded.firstRun) {
      openEditor();
    } else if (!hotkeyOk) {
      notify(t('notify.hotkeyTaken', { hotkey: cfg.hotkey }));
      openEditor();
    }
  });
}
