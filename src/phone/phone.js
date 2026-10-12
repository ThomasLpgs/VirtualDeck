/* global I18N:writable, applyI18n, t, PAGE_SIZE, pageGrid, pageTitle, createKey, createGlyph, isEmptyButton, markKeys, hasRunningTimer, renderDeckHeader, hmacSha256Hex, base64UrlToBytes */
// Phone deck, served by the PC (src/remote.js). The pairing key comes from the QR code's
// #fragment and stays on the phone; every call to the PC is signed with it (see shared/hmac.js).

const KEY_STORE = 'virtualdeck-key';
// Random id of this phone, so the PC can limit how many phones use the deck.
const DEVICE_STORE = 'virtualdeck-device';
// Must match --key-size / --key-gap in shared/keys.css: the grid is zoomed from that size.
const KEY_SIZE = 88;
const KEY_GAP = 10;
const MAX_ZOOM = 1.8;
const RETRY_MS = [1000, 2000, 5000, 10000];
// The PC answers a "wait" within 25 s: past 40 s, the connection is dead.
const WAIT_TIMEOUT_MS = 40 * 1000;
const CALL_TIMEOUT_MS = 10 * 1000;

const $ = (id) => document.getElementById(id);
const grid = $('grid');

let key = null;
// Phone clock minus PC clock: requests carry the PC's time (the PC rejects old requests).
let clockOffset = 0;
let state = null;
let page = 0;
let timer = null;
let toastTimer = null;
// Key pictures, downloaded once: image tag -> blob: URL. Failed ones aren't asked for again.
const images = new Map();
const loadingImages = new Set();
const failedImages = new Set();
// Several pictures arriving together: one redraw.
let renderQueued = false;
// The long poll in progress, cancelled when the page comes back on screen.
let listenController = null;

class Unpaired extends Error {}
// The PC already has as many phones as allowed.
class Full extends Error {}

function deviceId() {
  let id = localStorage.getItem(DEVICE_STORE);
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = nonce();
    localStorage.setItem(DEVICE_STORE, id);
  }
  return id;
}

function readKey() {
  const fromQr = /^#k=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (fromQr) {
    localStorage.setItem(KEY_STORE, fromQr[1]);
    // Off the address bar, history and bookmarks: the key lives in the phone's storage only.
    history.replaceState(null, '', location.pathname);
  }
  const stored = localStorage.getItem(KEY_STORE);
  return stored && /^[A-Za-z0-9_-]{43}$/.test(stored) ? base64UrlToBytes(stored) : null;
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Signed call to the PC. Throws Unpaired when the PC doesn't know our key (any more).
// Never waits forever: after a Wi-Fi change or the phone's sleep, a request can hang silently.
async function call(op, extra = {}, retried = false, controller = new AbortController()) {
  const body = JSON.stringify({ ts: Date.now() + clockOffset, nonce: nonce(), device: deviceId(), op, ...extra });
  const timeout = setTimeout(() => controller.abort(), op === 'wait' ? WAIT_TIMEOUT_MS : CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': hmacSha256Hex(key, body) },
      body,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'clock' && !retried && Number.isFinite(data.now)) {
    clockOffset = data.now - Date.now();
    return call(op, extra, true, controller);
  }
  if (res.status === 401 && data.error === 'unpaired') throw new Unpaired();
  if (res.status === 403 && data.error === 'full') throw new Full();
  if (res.status === 429) throw new Error(t('phone.blocked'));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showPairing() {
  localStorage.removeItem(KEY_STORE);
  key = null;
  $('pair').hidden = false;
}

function showFull() {
  key = null;
  $('pair-title').textContent = t('phone.fullTitle');
  $('pair-hint').textContent = t('phone.fullHint');
  $('pair').hidden = false;
}

// The PC refused this phone: why, on the whole screen.
function refused(err) {
  if (err instanceof Unpaired) showPairing();
  else if (err instanceof Full) showFull();
  else return false;
  return true;
}

function banner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
}

function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- Drawing ----------

const pageStart = () => page * PAGE_SIZE;

function visibleButtons() {
  const { cols, rows } = pageGrid(state, page);
  return state.buttons.slice(pageStart(), pageStart() + cols * rows);
}

// The keys keep the deck's proportions: the whole grid is zoomed to fill the screen.
function fit() {
  if (!state) return;
  const { cols, rows } = pageGrid(state, page);
  const stage = $('stage');
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const natural = (n) => n * KEY_SIZE + (n - 1) * KEY_GAP;
  grid.style.zoom = String(Math.min(MAX_ZOOM, width / natural(cols), height / natural(rows)));
}

function render() {
  if (!state) return;
  if (page >= state.pageCount) page = 0;
  const { cols } = pageGrid(state, page);
  grid.style.gridTemplateColumns = `repeat(${cols}, var(--key-size))`;
  grid.replaceChildren(
    ...visibleButtons().map((button, i) => {
      const shown = { ...button, imageUrl: images.get(button.image) || '' };
      if (button.image && !shown.imageUrl && !failedImages.has(button.image)) loadImage(pageStart() + i, button.image);
      const el = createKey(shown, i);
      if (!isEmptyButton(button)) el.addEventListener('click', () => press(i));
      return el;
    }),
  );
  $('pager').hidden = state.pageCount <= 1;
  $('page-label').textContent = pageTitle(state, page);
  renderStream();
  fit();
}

function renderStream() {
  renderDeckHeader($('deck-status'), state.stream);
  markKeys(grid.children, visibleButtons(), state.stream);
  // LIVE / REC badges count the time: refresh them every second while something runs and the
  // page is on screen (no battery spent while the phone is locked).
  clearInterval(timer);
  timer =
    hasRunningTimer(state.stream) && !document.hidden
      ? setInterval(() => markKeys(grid.children, visibleButtons(), state.stream), 1000)
      : null;
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

async function loadImage(index, tag) {
  if (loadingImages.has(tag)) return;
  loadingImages.add(tag);
  try {
    const { mime, data } = await call('image', { index });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    images.set(tag, URL.createObjectURL(new Blob([bytes], { type: mime })));
    queueRender();
  } catch (err) {
    if (refused(err)) return;
    // The PC has no picture to give (too big, missing file…): the key keeps its symbol / label.
    // A network error is tried again on the next redraw.
    if (err.message === 'not-found') failedImages.add(tag);
  } finally {
    loadingImages.delete(tag);
  }
}

function goToPage(target) {
  const count = state.pageCount;
  if (target === 'next') page = (page + 1) % count;
  else if (target === 'prev') page = (page - 1 + count) % count;
  else page = Math.min(count, Math.max(1, Number(target) || 1)) - 1;
  render();
}

async function press(index) {
  const el = grid.children[index];
  el.classList.remove('pressed', 'error', 'saved');
  void el.offsetWidth; // restart the animation
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 150);
  navigator.vibrate?.(12);
  const shownPage = page;
  // The grid may have been redrawn meanwhile (OBS event): mark the key now on screen.
  const mark = (className) => page === shownPage && grid.children[index]?.classList.add(className);
  try {
    const result = await call('press', { index: pageStart() + index });
    if (result.page) return goToPage(result.page);
    if (!result.ok || result.warning) {
      mark('error');
      toast(result.error || result.warning, true);
    } else if (result.notice) {
      mark('saved');
      toast(result.notice);
    }
  } catch (err) {
    if (refused(err)) return;
    mark('error');
    toast(t('phone.offline'), true);
  }
}

// ---------- Live updates ----------

function apply(next) {
  if (!next.buttons) return; // "nothing changed" reply
  // Pictures no key uses any more: free them.
  const used = new Set(next.buttons.map((b) => b.image));
  for (const [tag, url] of images) {
    if (!used.has(tag)) {
      URL.revokeObjectURL(url);
      images.delete(tag);
    }
  }
  state = next;
  render();
}

// Long polling: the PC answers as soon as something changes (or after a while, unchanged).
async function listen() {
  let failures = 0;
  for (;;) {
    listenController = new AbortController();
    const kicked = listenController.signal;
    try {
      const next = await call(state ? 'wait' : 'hello', state ? { since: state.version } : {}, false, listenController);
      if (next.buttons) apply(next);
      else state.version = next.version;
      failures = 0;
      banner('');
    } catch (err) {
      if (refused(err)) return;
      // Back on screen: ask again at once (the answer comes right away if something changed).
      if (kicked.reason === 'visible') continue;
      banner(err.message === t('phone.blocked') ? err.message : t('phone.offline'));
      await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]));
      failures += 1;
    }
  }
}

// ---------- Start ----------

[
  ['page-prev', 'chevron-left', 'prev'],
  ['page-next', 'chevron-right', 'next'],
].forEach(([id, icon, target]) => {
  $(id).append(createGlyph(icon));
  $(id).addEventListener('click', () => goToPage(target));
});

// Swipe left / right to change page.
let touchStart = null;
document.addEventListener('touchstart', (e) => (touchStart = e.touches.length === 1 ? e.touches[0] : null), { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touchStart || !state || state.pageCount <= 1) return;
  const dx = e.changedTouches[0].clientX - touchStart.clientX;
  const dy = e.changedTouches[0].clientY - touchStart.clientY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) goToPage(dx < 0 ? 'next' : 'prev');
  touchStart = null;
});
window.addEventListener('resize', fit);
// Back from the lock screen or another app: the long poll may be dead, start a fresh one.
document.addEventListener('visibilitychange', () => {
  if (state) renderStream();
  if (!document.hidden && key) listenController?.abort('visible');
});

(async () => {
  try {
    I18N = await (await fetch('/i18n.json', { cache: 'no-store' })).json();
  } catch {
    // Untranslated keys rather than nothing.
  }
  applyI18n();
  document.body.classList.remove('i18n-pending');
  key = readKey();
  if (!key) return showPairing();
  listen();
})();
