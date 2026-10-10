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
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const { ObsManager } = require('./obs');
const { runAction } = require('./actions');

const fs = require('fs');

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
// Must match "build.appId" in package.json, or Windows notifications won't show in the installed app.
const APP_ID = 'com.streamdeckvirtuel.app';
const LUCIDE_DIR = path.join(__dirname, '..', 'node_modules', 'lucide-static');
// Must match the CSS variables in shared/keys.css and the body padding in deck/deck.css.
const KEY_SIZE = 88;
const KEY_GAP = 10;
const PANEL_PADDING = 14;
const HEADER_HEIGHT = 34;
const SHADOW_MARGIN = 24;

const FILE_FILTERS = {
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'] }],
  sound: [{ name: 'Sons', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'] }],
  program: [
    { name: 'Programmes', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
    { name: 'Tous les fichiers', extensions: ['*'] },
  ],
};

// Sounds are triggered from a click in the deck, but may also be played while it is hidden.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The packaged app is named "Stream Deck virtuel" (productName), which would move the config
// to a new folder. Pin it so the installed app and `npm start` share the same buttons.
// Only when untouched, so test runs can still point userData elsewhere.
if (app.getPath('userData') === path.join(app.getPath('appData'), app.getName())) {
  app.setPath('userData', path.join(app.getPath('appData'), 'streamdeck-virtuel'));
}

let cfg;
let deckWin = null;
let editorWin = null;
let tray = null;
const obs = new ObsManager();

const fileUrl = (p) => (p ? pathToFileURL(p).href : '');

// Renderers can't build file:// URLs themselves (sandboxed preload), so add them here.
function forRenderer(c) {
  return { ...c, buttons: c.buttons.map((b) => ({ ...b, imageUrl: fileUrl(b.image) })) };
}

function broadcast(channel, data) {
  for (const win of [deckWin, editorWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Stream Deck virtuel', body }).show();
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
    title: 'Stream Deck virtuel — Configuration',
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

function trayIcon() {
  return nativeImage.createFromPath(APP_ICON).resize({ width: 32, height: 32, quality: 'best' });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(`Stream Deck virtuel (${cfg.hotkey})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir le deck', click: showDeck },
      { label: 'Configurer…', click: openEditor },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => openEditor());
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('config:get', () => forRenderer(cfg));

  ipcMain.handle('config:save', (_e, next) => {
    try {
      cfg = config.save(next);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const hotkeyOk = registerHotkey();
    app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin });
    tray.setToolTip(`Stream Deck virtuel (${cfg.hotkey})`);
    obs.configure(cfg.obs);
    broadcast('config:changed', forRenderer(cfg));
    return { ok: true, hotkeyOk };
  });

  ipcMain.handle('deck:press', async (_e, index) => {
    const button = cfg.buttons[index];
    if (!button) return { ok: false, error: 'Bouton introuvable.' };
    if (cfg.closeAfterAction) hideDeck();
    try {
      await runAction(button.action, { obs, playSound });
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
    const { canceled, filePaths } = await dialog.showOpenDialog(editorWin, {
      properties: ['openFile'],
      filters: FILE_FILTERS[kind] || [],
    });
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

  ipcMain.handle('obs:state', () => obs.state);
  ipcMain.handle('obs:connect', (_e, settings) => obs.configure(settings));
  ipcMain.handle('obs:scenes', () => obs.getScenes().catch(() => []));
  ipcMain.handle('obs:sources', (_e, scene) => obs.getSources(scene).catch(() => []));

  obs.on('state', (state) => broadcast('obs:state', state));
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

    registerIpc();
    createDeckWindow();
    createTray();
    obs.configure(cfg.obs);

    const hotkeyOk = registerHotkey();
    if (loaded.firstRun) {
      openEditor();
    } else if (!hotkeyOk) {
      notify(`Le raccourci ${cfg.hotkey} est déjà utilisé par une autre application. Change-le dans la configuration.`);
      openEditor();
    }
  });
}
