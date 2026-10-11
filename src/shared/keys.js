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

// Page p holds config.buttons[p * PAGE_SIZE ...]. Must match PAGE_SIZE in config.js.
const PAGE_SIZE = 48;

// Grid ({ cols, rows }) of a page (0-based): pages can have their own number of columns / rows.
function pageGrid(config, page) {
  return config.pageGrids?.[page] || config.grid;
}

// Keys that drive an output, on the horizontal canvas and/or the vertical one (action.target).
const OUTPUT_ACTIONS = ['obs-stream', 'obs-record', 'obs-replay'];

// Whether a key uses the vertical canvas (Aitum Vertical): scene, source, or output target.
function usesVertical(action) {
  if (action.type === 'multi') return (action.steps || []).some((step) => step?.action && usesVertical(step.action));
  return (
    (action.type === 'obs-scene' && Boolean(action.verticalScene)) ||
    (action.type === 'obs-source' && Boolean(action.verticalSource)) ||
    (OUTPUT_ACTIONS.includes(action.type) && Boolean(action.target) && action.target !== 'horizontal')
  );
}

// "1:23:45" / "4:05" from a timestamp until now (or until `until`).
function formatElapsed(since, until = Date.now()) {
  const total = Math.max(0, Math.floor((until - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Badge of keys showing a live state (stream, recording, muted input), or '' when off.
function keyBadge(action, streamState) {
  if (streamState.status !== 'connected') return '';
  // Keys on both canvases show the horizontal output while it runs, else the vertical one.
  const target = action.target || 'horizontal';
  const horizontal = target !== 'vertical';
  const vertical = target !== 'horizontal';
  switch (action.type) {
    case 'obs-stream': {
      const since = (horizontal && streamState.streamingSince) || (vertical && streamState.verticalStreamingSince);
      return since ? `LIVE ${formatElapsed(since)}` : '';
    }
    case 'obs-record':
      if (horizontal && streamState.recordingSince) {
        if (streamState.recordingPaused) {
          return `${t('badge.paused')} ${formatElapsed(streamState.recordingSince, streamState.recordingPausedAt)}`;
        }
        return `REC ${formatElapsed(streamState.recordingSince)}`;
      }
      return vertical && streamState.verticalRecordingSince ? `REC ${formatElapsed(streamState.verticalRecordingSince)}` : '';
    case 'obs-mute':
      return streamState.mutedInputs?.[action.input] ? t('badge.muted') : '';
    default:
      return '';
  }
}

// Whether a stream / recording timer is running, so the page refreshes the badges every second.
function hasRunningTimer(streamState) {
  const { streamingSince, recordingSince, verticalStreamingSince, verticalRecordingSince } = streamState;
  return (
    streamState.status === 'connected' &&
    Boolean(streamingSince || recordingSince || verticalStreamingSince || verticalRecordingSince)
  );
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
    const badge = keyBadge(button.action, streamState);
    key.classList.toggle('state-on', Boolean(badge));
    if (badge) key.dataset.badge = badge;
    else delete key.dataset.badge;
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
