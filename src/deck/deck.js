/* global PAGE_SIZE, pageGrid, createKey, createGlyph, isEmptyButton, markKeys, countVerticalIssues, hasRunningTimer, renderDeckHeader, loadI18n */
const panel = document.getElementById('panel');
const grid = document.getElementById('grid');
const statusEl = document.getElementById('deck-status');

// Lets the press animation play before the main process hides the window.
const PRESS_DELAY_MS = 90;

let config = null;
// Page shown (0-based), set by the main process.
let page = 0;
// This page is the popup bubble of a page key (popup page mode), not the deck itself.
const IS_POPUP = new URLSearchParams(location.search).has('popup');
document.body.classList.toggle('is-popup', IS_POPUP);
// A bubble layout received before the config was loaded.
let pendingPopup = null;
// Hidden, the page stays loaded but skips refreshing (timers, OBS events); it catches up when shown.
let visible = false;
let streamState = { status: 'disconnected', currentScene: null };
let audio = null;

const pageStart = () => page * PAGE_SIZE;

function visibleButtons() {
  const { cols, rows } = pageGrid(config, page);
  return config.buttons.slice(pageStart(), pageStart() + cols * rows);
}

// The whole page is zoomed; main.js sizes the window to match.
function applyScale(scale) {
  document.documentElement.style.zoom = String(scale || 1);
}

function render() {
  applyScale(config.deckScale);
  grid.style.gridTemplateColumns = `repeat(${pageGrid(config, page).cols}, var(--key-size))`;
  grid.replaceChildren(
    ...visibleButtons().map((button, i) => {
      const key = createKey(button, i);
      // An empty "+" key is an invitation to configure it.
      key.addEventListener('click', () => (isEmptyButton(button) ? window.api.openEditor(pageStart() + i) : press(i)));
      return key;
    }),
  );
  // Popup mode reaches the other pages through page keys only.
  $pager.hidden = config.pageCount <= 1 || config.pageMode === 'popup' || IS_POPUP;
  $pageLabel.textContent = `${page + 1}/${config.pageCount}`;
  renderObs();
}

function renderObs() {
  if (!config) return renderDeckHeader(statusEl, streamState);
  const buttons = visibleButtons();
  if (!IS_POPUP) renderDeckHeader(statusEl, streamState, countVerticalIssues(buttons, streamState));
  markKeys(grid.children, buttons, streamState);
}

async function press(index) {
  const key = grid.children[index];
  if (!key) return;
  key.classList.remove('pressed', 'error', 'saved');
  void key.offsetWidth; // restart the animation
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 150);

  await new Promise((r) => setTimeout(r, PRESS_DELAY_MS));
  // Where the key is, for a page key whose page opens as a bubble out of it.
  const box = key.getBoundingClientRect();
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  const result = await window.api.press(pageStart() + index, rect);
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
  if (digit) grid.children[Number(digit[1]) - 1]?.click();
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
// Popup bubble: which page, where its pointer is, and whether it opens below the key.
function showBubble(layout) {
  page = layout.page;
  document.body.classList.toggle('below', layout.below);
  panel.style.setProperty('--tail-x', `${layout.tailX}px`);
  document.getElementById('tail').hidden = false;
  document.getElementById('popup-title').hidden = false;
  document.getElementById('popup-label').textContent = t('page.n', { n: page + 1 });
  render();
  const opening = !visible;
  visible = true;
  if (!opening) return;
  panel.classList.remove('opening');
  void panel.offsetWidth;
  panel.classList.add('opening');
}

// Deck side: clicking its keys (or the gaps between them) closes a popup page.
if (!IS_POPUP) {
  grid.addEventListener('pointerdown', (e) => {
    const key = e.target.closest('.key');
    const index = key ? [...grid.children].indexOf(key) : -1;
    window.api.deckPointer(index < 0 ? null : pageStart() + index);
  });
}

if (IS_POPUP) {
  window.api.onDeckPopup((layout) => {
    if (config) showBubble(layout);
    else pendingPopup = layout;
  });
  const back = document.getElementById('popup-back');
  back.append(createGlyph('chevron-left'));
  back.addEventListener('click', () => window.api.closePopup());
}

window.api.onDeckHidden(() => {
  visible = false;
});
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
  if (pendingPopup) showBubble(pendingPopup);
})();
