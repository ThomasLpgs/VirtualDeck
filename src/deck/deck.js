/* global createKey, createGlyph, isEmptyButton, markKeys, countVerticalIssues, renderDeckHeader, loadI18n */
const panel = document.getElementById('panel');
const grid = document.getElementById('grid');
const statusEl = document.getElementById('deck-status');

// Lets the press animation play before the main process hides the window.
const PRESS_DELAY_MS = 90;

let config = null;
let streamState = { status: 'disconnected', currentScene: null };
let audio = null;

function visibleButtons() {
  return config.buttons.slice(0, config.grid.cols * config.grid.rows);
}

// The whole page is zoomed; main.js sizes the window to match.
function applyScale(scale) {
  document.documentElement.style.zoom = String(scale || 1);
}

function render() {
  applyScale(config.deckScale);
  grid.style.gridTemplateColumns = `repeat(${config.grid.cols}, var(--key-size))`;
  grid.replaceChildren(
    ...visibleButtons().map((button, i) => {
      const key = createKey(button, i);
      // An empty "+" key is an invitation to configure it.
      key.addEventListener('click', () => (isEmptyButton(button) ? window.api.openEditor(i) : press(i)));
      return key;
    }),
  );
  renderObs();
}

function renderObs() {
  if (!config) return renderDeckHeader(statusEl, streamState);
  const buttons = visibleButtons();
  renderDeckHeader(statusEl, streamState, countVerticalIssues(buttons, streamState));
  markKeys(grid.children, buttons, streamState);
}

async function press(index) {
  const key = grid.children[index];
  if (!key) return;
  key.classList.remove('pressed', 'error');
  void key.offsetWidth; // restart the animation
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 150);

  await new Promise((r) => setTimeout(r, PRESS_DELAY_MS));
  const result = await window.api.press(index);
  // A warning means only the horizontal part ran (vertical part blocked).
  if (!result.ok || result.warning) {
    key.classList.add('error');
    key.title = result.error || result.warning;
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

const openEditorButton = document.getElementById('open-editor');
openEditorButton.append(createGlyph('settings'));
openEditorButton.addEventListener('click', () => window.api.openEditor());

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.openEditor();
});

window.api.onDeckShow(() => {
  panel.classList.remove('opening');
  void panel.offsetWidth;
  panel.classList.add('opening');
});
window.api.onConfig((next) => {
  config = next;
  render();
});
window.api.onStreamState((state) => {
  streamState = state;
  renderObs();
});
window.api.onAudio(toggleAudio);
window.api.onDeckScale(applyScale);

(async () => {
  await loadI18n();
  [config, streamState] = await Promise.all([window.api.getConfig(), window.api.streamState()]);
  render();
})();
