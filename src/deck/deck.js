/* global PAGE_SIZE, createKey, createGlyph, isEmptyButton, markKeys, countVerticalIssues, hasRunningTimer, renderDeckHeader, loadI18n */
const panel = document.getElementById('panel');
const grid = document.getElementById('grid');
const statusEl = document.getElementById('deck-status');

// Lets the press animation play before the main process hides the window.
const PRESS_DELAY_MS = 90;

let config = null;
// Page shown (0-based), set by the main process.
let page = 0;
// Page shown over the deck in popup page mode ({ page, from }), or null.
let popup = null;
const $popup = document.getElementById('popup');
const $popupGrid = document.getElementById('popup-grid');
const $popupLabel = document.getElementById('popup-label');
// Hidden, the page stays loaded but skips refreshing (timers, OBS events); it catches up when shown.
let visible = false;
let streamState = { status: 'disconnected', currentScene: null };
let audio = null;

const pageStart = () => page * PAGE_SIZE;

function visibleButtons() {
  return config.buttons.slice(pageStart(), pageStart() + config.grid.cols * config.grid.rows);
}

// The whole page is zoomed; main.js sizes the window to match.
function applyScale(scale) {
  document.documentElement.style.zoom = String(scale || 1);
}

// Fills a grid with the keys of the page starting at `start` (an index in config.buttons).
function fillGrid(target, start) {
  target.style.gridTemplateColumns = `repeat(${config.grid.cols}, var(--key-size))`;
  const count = config.grid.cols * config.grid.rows;
  target.replaceChildren(
    ...config.buttons.slice(start, start + count).map((button, i) => {
      const key = createKey(button, i);
      // An empty "+" key is an invitation to configure it.
      key.addEventListener('click', () => (isEmptyButton(button) ? window.api.openEditor(start + i) : press(target, start, i)));
      return key;
    }),
  );
}

function render() {
  applyScale(config.deckScale);
  fillGrid(grid, pageStart());
  if (popup) fillGrid($popupGrid, popup.page * PAGE_SIZE);
  // Popup mode reaches the other pages through page keys only.
  $pager.hidden = config.pageCount <= 1 || config.pageMode === 'popup';
  $pageLabel.textContent = `${page + 1}/${config.pageCount}`;
  renderObs();
}

function renderObs() {
  if (!config) return renderDeckHeader(statusEl, streamState);
  const buttons = visibleButtons();
  renderDeckHeader(statusEl, streamState, countVerticalIssues(buttons, streamState));
  markKeys(grid.children, buttons, streamState);
}

// Opens (or replaces, or closes with null) the page shown over the deck.
function showPopup(next) {
  const opening = next && !popup;
  popup = next;
  $popup.hidden = !popup;
  panel.classList.toggle('covered', Boolean(popup));
  if (!popup) return;
  $popupLabel.textContent = t('page.n', { n: popup.page + 1 });
  fillGrid($popupGrid, popup.page * PAGE_SIZE);
  if (!opening) return;
  // Start the animation from the key that opened it (when it is on the deck), in CSS pixels.
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const from = popup.from !== null && popup.from >= pageStart() ? grid.children[popup.from - pageStart()] : null;
  const fromBox = from?.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  $popup.style.setProperty('--from-x', `${fromBox ? (fromBox.x + fromBox.width / 2 - (box.x + box.width / 2)) / zoom : 0}px`);
  $popup.style.setProperty('--from-y', `${fromBox ? (fromBox.y + fromBox.height / 2 - (box.y + box.height / 2)) / zoom : 0}px`);
  $popup.classList.remove('opening');
  void $popup.offsetWidth;
  $popup.classList.add('opening');
}

// index: position of the key in `target`, the grid of the page starting at `start`.
async function press(target, start, index) {
  const key = target.children[index];
  if (!key) return;
  key.classList.remove('pressed', 'error', 'saved');
  void key.offsetWidth; // restart the animation
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 150);

  await new Promise((r) => setTimeout(r, PRESS_DELAY_MS));
  const result = await window.api.press(start + index);
  // A warning means only the horizontal part ran (vertical part blocked).
  if (!result.ok || result.warning) {
    key.classList.add('error');
    key.title = result.error || result.warning;
  } else if (result.notice) {
    key.classList.add('saved');
    key.title = result.notice;
  }
}

// Clicking a sound key while it is playing stops it.
function toggleAudio({ url, volume }) {
  if (audio && audio.src === url && !audio.paused) {
    audio.pause();
    audio = null;
    return;
  }
  if (audio) audio.pause();
  audio = new Audio(url);
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.play().catch((err) => console.error('Lecture impossible :', err));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.api.hideDeck();
    return;
  }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) return window.api.turnPage(-1);
  if (['ArrowRight', 'PageDown'].includes(e.key)) return window.api.turnPage(1);
  const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
  if (digit) (popup ? $popupGrid : grid).children[Number(digit[1]) - 1]?.click();
});

// The transparent margin around the panel belongs to the window: treat clicks there as "outside".
document.body.addEventListener('mousedown', (e) => {
  if (e.target === document.body) window.api.hideDeck();
});

// Corner grip: main.js follows the mouse in screen pixels while the button is held.
const grip = document.getElementById('resize-grip');
let resizeFrame = 0;
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('dragging');
  window.api.resizeDeck('start');
});
grip.addEventListener('pointermove', () => {
  if (!grip.classList.contains('dragging') || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    window.api.resizeDeck('move');
  });
});
grip.addEventListener('lostpointercapture', () => {
  grip.classList.remove('dragging');
  window.api.resizeDeck('end');
});

const $pager = document.getElementById('pager');
const $pageLabel = document.getElementById('page-label');
for (const [id, icon, delta] of [
  ['page-prev', 'chevron-left', -1],
  ['page-next', 'chevron-right', 1],
]) {
  const pagerButton = document.getElementById(id);
  pagerButton.append(createGlyph(icon));
  pagerButton.addEventListener('click', () => window.api.turnPage(delta));
}

const openEditorButton = document.getElementById('open-editor');
openEditorButton.append(createGlyph('settings'));
openEditorButton.addEventListener('click', () => window.api.openEditor());

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.openEditor();
});

window.api.onDeckShow(() => {
  visible = true;
  renderObs();
  panel.classList.remove('opening');
  void panel.offsetWidth;
  panel.classList.add('opening');
});
window.api.onConfig((next) => {
  config = next;
  render();
});
window.api.onDeckPage((next) => {
  page = next;
  if (config) render();
});
window.api.onDeckPopup((next) => {
  if (config) showPopup(next);
});
window.api.onDeckHidden(() => {
  visible = false;
});
const popupBack = document.getElementById('popup-back');
popupBack.append(createGlyph('chevron-left'));
popupBack.addEventListener('click', () => window.api.closePopup());
window.api.onStreamState((state) => {
  streamState = state;
  if (visible) renderObs();
});
window.api.onAudio(toggleAudio);
window.api.onDeckScale(applyScale);
// Stream / recording timers on the keys.
setInterval(() => {
  if (visible && config && hasRunningTimer(streamState)) markKeys(grid.children, visibleButtons(), streamState);
}, 1000);

(async () => {
  await loadI18n();
  [config, streamState] = await Promise.all([window.api.getConfig(), window.api.streamState()]);
  render();
})();
