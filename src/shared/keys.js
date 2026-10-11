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

// Whether a key switches a vertical scene or animates a vertical source (Aitum Vertical).
function usesVertical(action) {
  return (action.type === 'obs-scene' && Boolean(action.verticalScene)) || (action.type === 'obs-source' && Boolean(action.verticalSource));
}

// Number of keys whose vertical part can't run: connected, but Aitum Vertical isn't detected.
function countVerticalIssues(buttons, streamState) {
  if (streamState.status !== 'connected' || streamState.verticalAvailable) return 0;
  return buttons.filter((button) => usesVertical(button.action)).length;
}

// Marks the keys of a rendered grid: LIVE badge, and a warning on keys whose vertical part is blocked.
function markKeys(keys, buttons, streamState) {
  const blocked = countVerticalIssues(buttons, streamState) > 0;
  buttons.forEach((button, i) => {
    const key = keys[i];
    if (!key) return;
    key.classList.toggle('active', isSceneLive(button.action, streamState));
    const warn = blocked && usesVertical(button.action);
    key.classList.toggle('vertical-warn', warn);
    if (warn) key.title = t('deck.verticalIssueKey');
    else if (key.title === t('deck.verticalIssueKey')) key.removeAttribute('title');
  });
}

// Whether a scene key's scene(s) are the ones on air, for the LIVE badge.
function isSceneLive(action, streamState) {
  if (action.type !== 'obs-scene' || streamState.status !== 'connected') return false;
  if (!action.scene && !action.verticalScene) return false;
  // Every scene the key switches must be on air.
  return (
    (!action.scene || action.scene === streamState.currentScene) &&
    (!action.verticalScene || action.verticalScene === streamState.verticalScene)
  );
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
// verticalIssues: number of keys whose vertical part is blocked; it then replaces the scene name.
function renderDeckHeader(statusEl, streamState, verticalIssues = 0) {
  statusEl.className = `deck-status ${streamState.status}`;
  statusEl.removeAttribute('title');
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const software = streamState.label || 'OBS';
  if (streamState.status === 'connected' && verticalIssues) {
    statusEl.classList.add('warn');
    statusEl.title = t('deck.verticalIssueHint', { count: verticalIssues });
    statusEl.replaceChildren(createGlyph('triangle-alert'), t('deck.verticalIssue', { count: verticalIssues }));
  } else if (streamState.status === 'connected') {
    const scene = document.createElement('strong');
    scene.textContent = streamState.currentScene || '—';
    statusEl.replaceChildren(dot, `${software} · `, scene);
  } else {
    const key = streamState.status === 'connecting' ? 'status.connectingTo' : 'status.offline';
    statusEl.replaceChildren(dot, t(key, { software }));
  }
}
