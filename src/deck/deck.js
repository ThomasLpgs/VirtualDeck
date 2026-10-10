/* global createKey, createGlyph, isEmptyButton, renderDeckHeader */
const panel = document.getElementById('panel');
const grid = document.getElementById('grid');
const statusEl = document.getElementById('deck-status');

// Lets the press animation play before the main process hides the window.
const PRESS_DELAY_MS = 90;

let config = null;
let obsState = { status: 'disconnected', currentScene: null };
let audio = null;

function visibleButtons() {
  return config.buttons.slice(0, config.grid.cols * config.grid.rows);
}

function render() {
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
  renderDeckHeader(statusEl, obsState);
  if (!config) return;
  visibleButtons().forEach((button, i) => {
    const isLive =
      obsState.status === 'connected' &&
      button.action.type === 'obs-scene' &&
      button.action.scene === obsState.currentScene;
    grid.children[i]?.classList.toggle('active', isLive);
  });
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
  if (!result.ok) {
    key.classList.add('error');
    key.title = result.error;
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
window.api.onObsState((state) => {
  obsState = state;
  renderObs();
});
window.api.onAudio(toggleAudio);

(async () => {
  [config, obsState] = await Promise.all([window.api.getConfig(), window.api.obsState()]);
  render();
})();
