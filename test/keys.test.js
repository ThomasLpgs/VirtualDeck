// Display logic shared by the deck and the editor preview (src/shared/keys.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScript } = require('./helpers');

const keys = loadBrowserScript('shared/keys.js', { Date });
const connected = (extra = {}) => ({ status: 'connected', currentScene: 'Game', verticalScene: 'V-Game', ...extra });

test('LIVE badge: every scene a key switches must be on air', () => {
  const { isSceneLive } = keys;
  assert.equal(isSceneLive({ type: 'obs-scene', scene: 'Game' }, connected()), true);
  assert.equal(isSceneLive({ type: 'obs-scene', verticalScene: 'V-Game' }, connected()), true);
  assert.equal(isSceneLive({ type: 'obs-scene', scene: 'Game', verticalScene: 'V-Other' }, connected()), false);
  assert.equal(isSceneLive({ type: 'obs-scene', scene: 'Game' }, { status: 'disconnected' }), false);
  assert.equal(isSceneLive({ type: 'obs-scene' }, connected()), false);
});

test('vertical keys are flagged when Aitum Vertical is missing', () => {
  const buttons = [
    { action: { type: 'obs-scene', scene: 'Game', verticalScene: 'V' } },
    { action: { type: 'obs-source', source: 'A', verticalSource: 'B' } },
    { action: { type: 'obs-replay', target: 'vertical' } },
    { action: { type: 'obs-stream', target: 'both' } },
    { action: { type: 'obs-record' } },
    { action: { type: 'multi', steps: [{ action: { type: 'obs-scene', verticalScene: 'V' } }] } },
    { action: { type: 'obs-scene', scene: 'Game' } },
  ];
  assert.equal(keys.countVerticalIssues(buttons, connected({ verticalAvailable: false })), 5);
  assert.equal(keys.countVerticalIssues(buttons, connected({ verticalAvailable: true })), 0);
  // Offline: no warning, the deck already says OBS is offline.
  assert.equal(keys.countVerticalIssues(buttons, { status: 'disconnected' }), 0);
});

test('stream, record and mute badges', () => {
  const now = Date.now();
  const state = connected({
    streamingSince: now - (3600 + 2 * 60 + 3) * 1000,
    recordingSince: now - 65 * 1000,
    mutedInputs: { Mic: true, Music: false },
  });
  assert.equal(keys.keyBadge({ type: 'obs-stream' }, state), 'LIVE 1:02:03');
  assert.equal(keys.keyBadge({ type: 'obs-record' }, state), 'REC 1:05');
  // Paused 30 s after starting: the time stays frozen at 0:30 however long the pause lasts.
  const paused = { ...state, recordingSince: now - 90 * 1000, recordingPaused: true, recordingPausedAt: now - 60 * 1000 };
  assert.equal(keys.keyBadge({ type: 'obs-record' }, paused), 'PAUSED 0:30');
  assert.equal(keys.keyBadge({ type: 'obs-mute', input: 'Mic' }, state), 'MUTED');
  assert.equal(keys.keyBadge({ type: 'obs-mute', input: 'Music' }, state), '');
  assert.equal(keys.keyBadge({ type: 'obs-stream' }, connected()), '');
  assert.equal(keys.hasRunningTimer(state), true);
  assert.equal(keys.hasRunningTimer(connected()), false);
});

test("a microphone key shows its microphones muted, with or without OBS", () => {
  const mic = { type: 'media', key: 'micMute' };
  const headset = { ...mic, device: 'headset' };
  assert.equal(keys.keyBadge(mic, { status: 'disconnected', micMuted: { '': true } }), 'MUTED');
  assert.equal(keys.keyBadge(mic, { status: 'connected', micMuted: { '': false } }), '');
  assert.equal(keys.keyBadge(mic, { status: 'disconnected', micMuted: { '': null } }), '');
  assert.equal(keys.keyBadge(mic, { status: 'disconnected', micMuted: {} }), '');
  // Each key follows its own microphone.
  assert.equal(keys.keyBadge(headset, { status: 'disconnected', micMuted: { '': false, headset: true } }), 'MUTED');
  assert.equal(keys.keyBadge(mic, { status: 'disconnected', micMuted: { '': false, headset: true } }), '');
  assert.equal(keys.keyBadge({ type: 'media', key: 'next' }, { status: 'disconnected', micMuted: { '': true } }), '');
});
