/* global t -- from shared/i18n.js */
/* eslint-disable no-unused-vars -- these helpers are used by deck.js and editor.js */

// Both deck/ and editor/ pages live two levels below the project root.
const ICON_BASE = '../../node_modules/lucide-static/icons/';
const SAFE_ICON_NAME = /^[a-z0-9-]+$/;

// Lucide icon tinted with currentColor through a CSS mask.
function createGlyph(name, className = 'glyph') {
  const glyph = document.createElement('span');
  glyph.className = className;
  glyph.setAttribute('aria-hidden', 'true');
  if (SAFE_ICON_NAME.test(name)) glyph.style.setProperty('--icon', `url("${ICON_BASE}${name}.svg")`);
  return glyph;
}

function isEmptyButton(button) {
  return button.action.type === 'none' && !button.label && !button.icon && !button.symbol && !button.image;
}

// Builds the DOM for one deck key. Visual priority: image > Lucide symbol > emoji.
function createKey(button, index) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'key';
  el.dataset.index = index;
  el.style.setProperty('--key-color', button.color);
  el.style.setProperty('--i', index);

  const empty = isEmptyButton(button);
  if (empty) el.classList.add('empty');

  if (index < 9 && !empty) {
    const hint = document.createElement('span');
    hint.className = 'key-hint';
    hint.textContent = String(index + 1);
    el.append(hint);
  }

  const media = document.createElement('span');
  media.className = 'key-media';
  if (button.imageUrl) {
    const img = document.createElement('img');
    img.className = 'key-img';
    img.src = button.imageUrl;
    img.alt = '';
    media.append(img);
  } else if (button.symbol) {
    media.append(createGlyph(button.symbol));
  } else if (button.icon) {
    const emoji = document.createElement('span');
    emoji.className = 'key-emoji';
    emoji.textContent = button.icon;
    media.append(emoji);
  } else if (empty) {
    media.append(createGlyph('plus'));
  }
  if (media.childElementCount) el.append(media);

  if (button.label) {
    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = button.label;
    el.append(label);
  }

  el.setAttribute('aria-label', button.label || t('editor.buttonN', { n: index + 1 }));
  return el;
}

// Fills the small status line at the top of the deck panel.
// streamState: { status, currentScene, label } where label is "OBS" or "Streamlabs".
function renderDeckHeader(statusEl, streamState) {
  statusEl.className = `deck-status ${streamState.status}`;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const software = streamState.label || 'OBS';
  if (streamState.status === 'connected') {
    const scene = document.createElement('strong');
    scene.textContent = streamState.currentScene || '—';
    statusEl.replaceChildren(dot, `${software} · `, scene);
  } else {
    const key = streamState.status === 'connecting' ? 'status.connectingTo' : 'status.offline';
    statusEl.replaceChildren(dot, t(key, { software }));
  }
}
