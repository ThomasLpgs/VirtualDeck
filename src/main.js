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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode-generator');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const i18n = require('./i18n');
const { ObsManager } = require('./obs');
const { StreamlabsManager } = require('./streamlabs');
const { runAction, needsStream } = require('./actions');
const backup = require('./backup');
const { checkForUpdate } = require('./updates');
const remote = require('./remote');
const { saveAppIcon } = require('./app-icon');

const { t } = i18n;

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
// Same logo as an .ico, for the taskbar in development (see showInTaskbar).
const APP_ICON_ICO = path.join(__dirname, 'assets', 'icon.ico');
// Must match "build.appId" in package.json, or Windows notifications won't show in the installed app.
const APP_ID = 'com.virtualdeck.app';
// Added to the "launch at login" entry: started with Windows, the app stays in the tray;
// started by the user (shortcut, Start menu), it opens the editor.
const LOGIN_ARG = '--at-login';
const loginItem = (openAtLogin) => ({ openAtLogin, args: [LOGIN_ARG] });
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
// Pointer under a popup page: its height, and how far its tip reaches into the key (CSS pixels).
const TAIL_SIZE = 12;
const TAIL_DEPTH = 10;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
// How often the phone server checks that the PC's network address hasn't changed.
const REMOTE_ADDRESS_CHECK_MS = 60 * 1000;
// Images a phone can download (key pictures), at most.
const MAX_PHONE_IMAGE = 3 * 1024 * 1024;

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
// Popup page mode: a page opens in this window, as a bubble above the key that asked for it.
let popupWin = null;
let popupLayout = null;
// Resolves once popupWin has loaded its page.
let popupReady = null;
// Page shown by the deck (0-based). Not saved: the deck starts on the first page.
// In 'popup' page mode, the deck itself stays on page 1 and this is the page in the bubble.
let deckPage = 0;
let lastPageMode = null;
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
// The phone pairing key stays in the main process (the editor shows it as a QR code on demand).
function forRenderer(c) {
  return {
    ...c,
    remote: { enabled: c.remote.enabled },
    buttons: c.buttons.map((b) => ({ ...b, imageUrl: fileUrl(b.image) })),
  };
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
  for (const win of [deckWin, popupWin, editorWin]) {
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
// page: whose grid to fit (pages have their own grid); by default the one the deck shows.
function deckSize(page = cfg.pageMode === 'popup' ? 0 : deckPage) {
  const { cols, rows } = config.gridOf(cfg, page);
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
  // A popup page is sized and placed for the old size: close it rather than distort it.
  closePopup();
  liveScale = null;
  cfg = config.save({ ...cfg, deckScale });
  if (deckWin.isVisible()) resizeDeckWindow();
  broadcast('config:changed', forRenderer(cfg));
}

// Corner grip of the deck: the scale follows the mouse, measured here in screen pixels.
function onDeckResize(phase) {
  if (phase === 'start') {
    closePopup();
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
  deckWin.webContents.on('did-finish-load', () => {
    if (cfg.pageMode === 'popup') deckPage = 0;
    deckWin.webContents.send('deck:page', deckPage);
  });
  deckWin.on('blur', hideIfFocusLeft);
  deckWin.on('move', followDeck);
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
  activeStream().wake();
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
// origin: the key that asked for it, { win, rect } (rect within win), for a popup page.
function goToPage(target, origin = null) {
  const count = cfg.pageCount;
  if (target === 'next') deckPage = (deckPage + 1) % count;
  else if (target === 'prev') deckPage = (deckPage - 1 + count) % count;
  else deckPage = Math.min(count, Math.max(1, Number(target) || 1)) - 1;
  if (cfg.pageMode !== 'popup') {
    deckWin.webContents.send('deck:page', deckPage);
    // Pages can have their own grid: fit the deck to the page now shown.
    if (deckWin.isVisible()) resizeDeckWindow();
    return;
  }
  // Popup mode: page 1 is the deck itself, any other page opens in the bubble.
  if (deckPage === 0) closePopup();
  else showPopupPage(origin);
}

// Loads the bubble window ahead of time (popup page mode), so the first bubble opens at once.
function preparePopupWindow() {
  if (!popupWin || popupWin.isDestroyed()) popupReady = createPopupWindow();
}

function createPopupWindow() {
  popupWin = new BrowserWindow({
    ...deckSize(),
    // Owned by the deck: Windows keeps it above the deck, whichever was clicked last.
    parent: deckWin,
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
  popupWin.setAlwaysOnTop(true, 'screen-saver');
  popupWin.on('blur', hideIfFocusLeft);
  return new Promise((resolve) => {
    popupWin.webContents.once('did-finish-load', resolve);
    popupWin.loadFile(path.join(__dirname, 'deck', 'index.html'), { query: { popup: '1' } });
  });
}

// Shows the page `deckPage` as a bubble above the key that opened it, its pointer reaching into
// that key, like a genie out of its lamp. Below the key when there is no room above it.
async function showPopupPage(origin) {
  // The key that opened the bubble closes it: it is a temporary deck.
  if (origin?.win === deckWin && popupOpen() && popupLayout?.fromIndex === origin.index) return closePopup();
  preparePopupWindow();
  await popupReady;
  const scale = liveScale ?? cfg.deckScale;
  const { width, height } = deckSize(deckPage);
  if (origin?.win === popupWin && popupLayout) {
    // A page key inside the bubble: it stays where it is, resized to the new page's grid.
    popupLayout = {
      ...popupLayout,
      page: deckPage,
      bounds: { ...popupLayout.bounds, width, height },
      tailX: Math.min(popupLayout.tailX, width / scale - SHADOW_MARGIN - 26),
    };
  } else {
    const base = (origin?.win ?? deckWin).getBounds();
    // Without a key (hotkey, arrow keys), the bubble rises from the top of the deck.
    const rect = origin?.rect ?? { x: base.width / 2 - 1, y: SHADOW_MARGIN * scale, width: 2, height: 2 };
    const key = { x: base.x + rect.x, y: base.y + rect.y, width: rect.width, height: rect.height };
    const centerX = key.x + key.width / 2;
    const area = screen.getDisplayNearestPoint({ x: Math.round(centerX), y: Math.round(key.y) }).workArea;
    const margin = SHADOW_MARGIN * scale;
    // The window keeps a transparent margin for the shadow; the pointer sits in it.
    let y = Math.round(key.y + TAIL_DEPTH * scale - (height - margin + TAIL_SIZE * scale));
    const below = y < area.y - margin;
    if (below) y = Math.round(key.y + key.height - TAIL_DEPTH * scale - (margin - TAIL_SIZE * scale));
    const x = Math.round(Math.min(Math.max(centerX - width / 2, area.x - margin), area.x + area.width - width + margin));
    // Pointer position in the page's CSS pixels, kept away from the rounded corners.
    const tailX = Math.min(Math.max((centerX - x) / scale, SHADOW_MARGIN + 26), width / scale - SHADOW_MARGIN - 26);
    popupLayout = {
      page: deckPage,
      tailX,
      below,
      bounds: { x, y, width, height },
      // To close it from that key again, and to follow the deck when it is dragged.
      fromIndex: origin?.win === deckWin ? origin.index : null,
      deckBounds: deckWin.getBounds(),
    };
  }
  popupWin.setBounds(popupLayout.bounds);
  popupWin.webContents.send('deck:popup', { page: popupLayout.page, tailX: popupLayout.tailX, below: popupLayout.below });
  // Without taking the focus: the keyboard (Esc, 1-9) keeps going to the deck.
  if (!popupWin.isVisible()) popupWin.showInactive();
}

const popupOpen = () => Boolean(popupWin && !popupWin.isDestroyed() && popupWin.isVisible());

// The bubble moves with the deck while the deck is dragged.
function followDeck() {
  if (!popupOpen() || !popupLayout) return;
  const deck = deckWin.getBounds();
  const { bounds, deckBounds } = popupLayout;
  popupWin.setBounds({ ...bounds, x: bounds.x + deck.x - deckBounds.x, y: bounds.y + deck.y - deckBounds.y });
}

function closePopup() {
  if (cfg.pageMode === 'popup') deckPage = 0;
  popupLayout = null;
  if (!popupWin || popupWin.isDestroyed() || !popupWin.isVisible()) return;
  popupWin.hide();
  popupWin.webContents.send('deck:hidden');
}

// The deck and its popup page act as one: they close when the focus goes anywhere else.
function hideIfFocusLeft() {
  setTimeout(() => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused !== deckWin && focused !== popupWin) hideDeck();
  }, 50);
}

function hideDeck() {
  closePopup();
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
// With our app id set, Windows takes the taskbar icon from the running exe. Installed, that is
// VirtualDeck.exe (our logo); with `npm start` it is electron.exe, so give the window our logo.
function showInTaskbar(win) {
  if (app.isPackaged) return;
  win.setAppDetails({ appId: APP_ID, appIconPath: APP_ICON_ICO, appIconIndex: 0 });
}

function openEditor(buttonIndex) {
  activeStream().wake();
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
  showInTaskbar(editorWin);
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
// What the registered hotkeys were built from, so a save that doesn't touch them skips the
// (slow-ish) unregister / register round trip with Windows.
let registeredHotkeys = null;
let deckHotkeyOk = false;
let loginItemSet = null;

const hotkeySignature = () =>
  JSON.stringify([cfg.hotkey, cfg.pageCount, cfg.pageGrids, cfg.buttons.map((b) => (b.action.type === 'none' ? '' : b.hotkey))]);

// Registers the deck hotkey and the hotkey of each key. Returns whether the deck hotkey worked.
function registerHotkey() {
  globalShortcut.unregisterAll();
  registeredHotkeys = hotkeySignature();
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
  cfg.buttons.forEach((button, index) => {
    // Only keys that can be seen in the deck: on an existing page, within that page's grid.
    const keyPage = Math.floor(index / config.PAGE_SIZE);
    const { cols, rows } = config.gridOf(cfg, keyPage);
    if (keyPage >= cfg.pageCount || index % config.PAGE_SIZE >= cols * rows) return;
    if (!button.hotkey || button.action.type === 'none') return;
    if (used.has(button.hotkey) || !register(button.hotkey, () => runKey(index))) failedKeyHotkeys.push(index);
    used.add(button.hotkey);
  });
  deckHotkeyOk = deckOk;
  return deckOk;
}

const { hidePaths } = remote;

const WAKE_WAIT_MS = 2000;

// Before a key that drives OBS / Streamlabs runs: if it was waiting for its next attempt (it may
// have been started since), connect now and give it a moment, rather than failing the key.
// Other keys don't wait: on Windows a refused local connection takes about 2 s to fail.
function wakeStream(action) {
  if (!needsStream(action)) return Promise.resolve();
  const stream = activeStream();
  if (!stream.wake()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stream.off('state', check);
      resolve();
    };
    const check = (state) => state.status !== 'connecting' && done();
    const timer = setTimeout(done, WAKE_WAIT_MS);
    stream.on('state', check);
  });
}

// Runs a key, from the deck, from its own hotkey or from a phone. When the deck isn't on screen
// (closed after the action, or never opened), errors and confirmations are shown as notifications.
// A phone gets the result instead, and turns its own pages (result.page).
async function runKey(index, { fromDeck = false, origin = null, fromPhone = false } = {}) {
  const button = cfg.buttons[index];
  if (!button) return { ok: false, error: t('error.buttonNotFound') };
  if (fromPhone) {
    try {
      await wakeStream(button.action);
      const result = await runAction(button.action, { stream: activeStream(), playSound });
      return { ok: true, warning: hidePaths(result?.warning), notice: hidePaths(result?.notice), page: result?.page };
    } catch (err) {
      return { ok: false, error: hidePaths(err.message) };
    }
  }
  // A page key changes what the deck shows: it must not close it.
  const closes = fromDeck && cfg.closeAfterAction && button.action.type !== 'page';
  if (closes) hideDeck();
  const unseen = !fromDeck || closes;
  // After closing the deck: waiting for OBS must not keep it on screen.
  await wakeStream(button.action);
  try {
    const result = await runAction(button.action, { stream: activeStream(), playSound });
    if (result?.page) {
      // From a hotkey (or after the deck closed), open the deck on that page.
      if (!deckWin.isVisible()) showDeck();
      goToPage(result.page, origin);
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
  // Switching page mode starts again from the deck's first page.
  if (lastPageMode && lastPageMode !== cfg.pageMode) {
    closePopup();
    deckPage = 0;
    deckWin.webContents.send('deck:page', 0);
  }
  lastPageMode = cfg.pageMode;
  if (cfg.pageMode === 'popup') preparePopupWindow();
  if (deckPage >= cfg.pageCount) goToPage(1);
  const hotkeyOk = registeredHotkeys === hotkeySignature() ? deckHotkeyOk : registerHotkey();
  // Writes to the registry: only when the setting changes.
  if (loginItemSet !== cfg.launchAtLogin) {
    app.setLoginItemSettings(loginItem(cfg.launchAtLogin));
    loginItemSet = cfg.launchAtLogin;
  }
  activateStream();

  if (applyLanguage() !== previousLanguage) {
    // Simplest way to retranslate everything: reload the pages (the config is already saved).
    updateTray();
    for (const win of [deckWin, popupWin, editorWin]) if (win && !win.isDestroyed()) win.webContents.reload();
    if (editorWin && !editorWin.isDestroyed()) editorWin.setTitle(t('editor.windowTitle'));
  } else {
    updateTray();
    broadcast('config:changed', forRenderer(cfg));
  }
  phoneServer.changed();
  return hotkeyOk;
}

// ---------- Phone as a deck (remote.js) ----------

// What a phone needs to draw the deck. Only the action fields the keys display (scene names,
// muted input...): no file paths, programs or URLs leave the PC.
const PHONE_ACTION_FIELDS = ['type', 'scene', 'verticalScene', 'source', 'verticalSource', 'input', 'page'];

function phoneAction(action = {}) {
  const copy = Object.fromEntries(PHONE_ACTION_FIELDS.filter((f) => typeof action[f] === 'string').map((f) => [f, action[f]]));
  // `target` is the output (horizontal / vertical) on output keys, but a path on program keys.
  if (['obs-stream', 'obs-record', 'obs-replay'].includes(action.type) && typeof action.target === 'string') {
    copy.target = action.target;
  }
  if (action.type === 'multi') copy.steps = (action.steps || []).map((step) => ({ action: phoneAction(step?.action) }));
  return copy;
}

// Changes when the key's picture changes, so the phone knows when to download it again.
function imageTag(file) {
  if (!file) return '';
  try {
    return crypto.createHash('sha1').update(`${file}|${fs.statSync(file).mtimeMs}`).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

function phoneState() {
  return {
    pageCount: cfg.pageCount,
    pageGrids: cfg.pageGrids,
    pageNames: cfg.pageNames,
    grid: cfg.grid,
    buttons: cfg.buttons.map((b) => ({
      label: b.label,
      symbol: b.symbol,
      icon: b.icon,
      color: b.color,
      image: imageTag(b.image),
      action: phoneAction(b.action),
    })),
    stream: streamState(),
  };
}

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

async function phoneImage(index) {
  const file = cfg.buttons[index]?.image;
  const mime = file && IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_PHONE_IMAGE) return null;
    return { mime, data: (await fs.promises.readFile(file)).toString('base64') };
  } catch {
    return null;
  }
}

const phoneServer = remote.createRemoteServer({
  key: () => cfg.remote.key,
  state: phoneState,
  i18n: () => i18n.bundle(),
  press: (index) => runKey(index, { fromPhone: true }),
  image: phoneImage,
  allowDevice,
});

// A phone not seen before takes a free place, kept after a restart (written once, when it first
// connects). Once every place is taken, other devices are refused, even if they scan the QR code.
function allowDevice(id) {
  const { devices, maxPhones } = cfg.remote;
  if (devices.includes(id)) return true;
  if (maxPhones && devices.length >= maxPhones) return false;
  saveRemote({ devices: [...devices, id] });
  return true;
}
// Why the server couldn't start (no network...), shown in the settings.
let remoteError = '';

// Saved once per change (enabling the first time sets enabled, key and port together).
function saveRemote(patch) {
  const next = { ...cfg.remote, ...patch };
  if (Object.keys(next).every((field) => next[field] === cfg.remote[field])) return;
  cfg = config.save({ ...cfg, remote: next });
}

// Starts, restarts (new network address or key) or stops the phone server to match the setting.
// One at a time: the settings page and the address check may ask together.
let remoteSync = Promise.resolve();
function syncRemote(patch = {}) {
  remoteSync = remoteSync
    .then(() => syncRemoteNow(patch))
    // Keeps the queue alive (a failed config write must not block every later sync).
    .catch((err) => {
      remoteError = err.message;
    });
  return remoteSync;
}

async function syncRemoteNow(patch) {
  const settings = { ...cfg.remote, ...patch };
  if (settings.enabled && !remote.isKey(settings.key)) settings.key = remote.newKey();
  const address = settings.enabled ? remote.pickLanAddress(os.networkInterfaces()) : null;
  const current = phoneServer.address();
  if (current && address === current.host && settings.key === cfg.remote.key) return saveRemote(settings);
  phoneServer.stop();
  remoteError = '';
  if (address) {
    try {
      // Keep the same port next time, so the phone's bookmark keeps working.
      settings.port = await phoneServer.start(address, settings.port);
    } catch (err) {
      remoteError = err.message;
    }
  } else if (settings.enabled) {
    remoteError = t('phone.noNetwork');
  }
  saveRemote(settings);
}

function remoteStatus() {
  const address = phoneServer.address();
  return {
    enabled: cfg.remote.enabled,
    url: address ? `http://${address.host}:${address.port}` : '',
    phones: phoneServer.phones(),
    paired: cfg.remote.devices.length,
    maxPhones: cfg.remote.maxPhones,
    error: remoteError,
  };
}

// QR code of the pairing link (an SVG data: URL). The key is in the #fragment: browsers never send it.
function remoteQr() {
  const address = phoneServer.address();
  if (!address) return '';
  const qr = qrcode(0, 'M');
  qr.addData(`http://${address.host}:${address.port}/#k=${cfg.remote.key}`);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('config:get', () => forRenderer(cfg));
  ipcMain.handle('i18n:get', () => i18n.bundle());

  ipcMain.handle('config:save', (_e, next) => {
    try {
      // Position and size are set from the deck itself (see saveDeckPosition / saveDeckScale).
      // The phone settings change through remote:* only (the editor never sees the pairing key).
      const hotkeyOk = applyConfig({ ...next, deckPosition: cfg.deckPosition, deckScale: cfg.deckScale, remote: cfg.remote });
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
        pageGrids: imported.pageGrids,
        pageNames: imported.pageNames,
        // Same rule as the deck hotkey: an imported key can't grab Ctrl+C or Alt+Tab system-wide.
        buttons: imported.buttons.map((b) => (isImportableHotkey(b?.hotkey) ? b : { ...b, hotkey: '' })),
      });
      return { ok: true, hotkeyOk, config: forRenderer(cfg), buttonCount: imported.buttons.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // rect: where the pressed key is in its window, for a popup page to grow out of it.
  ipcMain.handle('deck:press', (e, index, rect) =>
    runKey(index, { fromDeck: true, origin: rect ? { win: BrowserWindow.fromWebContents(e.sender), rect, index } : null }),
  );

  ipcMain.on('deck:hide', hideDeck);
  ipcMain.on('deck:resetPosition', () => saveDeckPosition(null));
  ipcMain.on('deck:turnPage', (_e, delta) => goToPage(delta < 0 ? 'prev' : 'next'));
  // A click on the deck's keys closes the bubble, except on the key that opened it (that key
  // toggles it when its press arrives).
  ipcMain.on('deck:pointer', (_e, index) => {
    if (popupOpen() && index !== popupLayout?.fromIndex) closePopup();
  });
  ipcMain.on('deck:closePopup', () => {
    closePopup();
    if (deckWin.isVisible()) deckWin.focus();
  });
  ipcMain.on('deck:resize', (_e, phase) => onDeckResize(phase));
  const clampScale = (scale) => Math.min(config.MAX_DECK_SCALE, Math.max(config.MIN_DECK_SCALE, scale));
  ipcMain.on('deck:setScale', (_e, scale) => {
    if (Number.isFinite(scale)) saveDeckScale(clampScale(scale));
  });
  // While the slider moves: resize the open deck only; deck:setScale saves on release.
  ipcMain.on('deck:previewScale', (_e, scale) => {
    if (!Number.isFinite(scale)) return;
    closePopup();
    liveScale = clampScale(scale);
    deckWin.webContents.send('deck:scale', liveScale);
    if (deckWin.isVisible()) resizeDeckWindow();
  });
  ipcMain.on('editor:open', (_e, buttonIndex) => {
    hideDeck();
    openEditor(buttonIndex);
  });

  // The editor's hotkey field needs to receive the combo instead of the global shortcut.
  ipcMain.on('hotkey:pause', (_e, paused) => {
    if (paused) {
      globalShortcut.unregisterAll();
      registeredHotkeys = null;
    } else {
      registerHotkey();
    }
  });

  ipcMain.handle('dialog:pick', async (_e, kind) => {
    const filters = FILE_EXTENSIONS[kind] ? [{ name: t(`file.${kind}`), extensions: FILE_EXTENSIONS[kind] }] : [];
    if (kind === 'program') filters.push({ name: t('file.all'), extensions: ['*'] });
    const { canceled, filePaths } = await dialog.showOpenDialog(editorWin, { properties: ['openFile'], filters });
    if (canceled || !filePaths[0]) return null;
    return { path: filePaths[0], url: fileUrl(filePaths[0]) };
  });

  // Picture of an "Open" key taken from the program it opens (Spotify, OBS…).
  ipcMain.handle('icon:fromProgram', async (_e, target) => {
    try {
      const file = await saveAppIcon(target, path.join(app.getPath('userData'), 'media'), { app, shell });
      return file ? { path: file, url: fileUrl(file) } : null;
    } catch {
      return null;
    }
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

  ipcMain.handle('remote:get', async () => {
    await syncRemote();
    return remoteStatus();
  });
  ipcMain.handle('remote:setEnabled', async (_e, enabled) => {
    await syncRemote({ enabled: enabled === true });
    return remoteStatus();
  });
  ipcMain.handle('remote:qr', () => remoteQr());
  // A new key unpairs every phone: they need to scan the new QR code.
  ipcMain.handle('remote:newKey', async () => {
    await syncRemote({ key: remote.newKey(), devices: [] });
    return remoteStatus();
  });
  // Fewer places than phones already paired: the first ones keep theirs.
  ipcMain.handle('remote:setMaxPhones', (_e, maxPhones) => {
    const max = [0, 1, 2, 3].includes(maxPhones) ? maxPhones : 1;
    saveRemote({ maxPhones: max, devices: max ? cfg.remote.devices.slice(0, max) : cfg.remote.devices });
    return remoteStatus();
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
      if (client !== activeStream()) return;
      broadcast('stream:state', streamState());
      phoneServer.changed();
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
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    phoneServer.stop();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    const loaded = config.load();
    cfg = loaded.config;
    lastPageMode = cfg.pageMode;
    applyLanguage();
    // Keeps the startup entry pointing at the current exe, e.g. after a reinstall elsewhere.
    if (app.isPackaged) app.setLoginItemSettings(loginItem(cfg.launchAtLogin));

    registerIpc();
    createDeckWindow();
    if (cfg.pageMode === 'popup') preparePopupWindow();
    createTray();
    activateStream();

    // A short delay keeps the check off the startup path (the app may start with Windows, before the network).
    setTimeout(checkUpdates, 15000);
    setInterval(checkUpdates, UPDATE_CHECK_MS);
    syncRemote();
    // The PC can change network (other Wi-Fi, new address from the router): follow it.
    setInterval(() => cfg.remote.enabled && syncRemote(), REMOTE_ADDRESS_CHECK_MS);

    const hotkeyOk = registerHotkey();
    if (!hotkeyOk && !loaded.firstRun) notify(t('notify.hotkeyTaken', { hotkey: cfg.hotkey }));
    // Opened by the user: show it, otherwise it looks like nothing happened (it lives in the tray).
    if (loaded.firstRun || !hotkeyOk || !process.argv.includes(LOGIN_ARG)) openEditor();
  });
}
