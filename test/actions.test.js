const test = require('node:test');
const assert = require('node:assert/strict');
const { electron, connectedObs, aitum } = require('./helpers');
const { runAction, needsStream, needsFocus } = require('../src/actions');

const run = (action, obs, extra = {}) => runAction(action, { stream: obs, playSound: () => {}, ...extra });
const requests = (calls, type) => calls.filter(([request]) => request === type);
const vendorRequests = (calls, type) => calls.filter(([r, d]) => r === 'CallVendorRequest' && d.requestType === type);

test.describe('scene keys', () => {
  test('switches the horizontal scene', async () => {
    const { obs, calls } = await connectedObs();
    await run({ type: 'obs-scene', scene: 'Pause' }, obs);
    assert.deepEqual(requests(calls, 'SetCurrentProgramScene').map(([, d]) => d.sceneName), ['Pause']);
    assert.equal(obs.state.currentScene, 'Pause');
  });

  test('switches both scenes with Aitum Vertical', async () => {
    const { obs, calls } = await connectedObs(aitum());
    await run({ type: 'obs-scene', scene: 'Pause', verticalScene: 'V-Game' }, obs);
    assert.equal(requests(calls, 'SetCurrentProgramScene').length, 1);
    assert.deepEqual(vendorRequests(calls, 'switch_scene').map(([, d]) => d.requestData.scene), ['V-Game']);
    assert.equal(obs.state.verticalScene, 'V-Game');
  });

  test('a vertical typo changes nothing, not even the horizontal scene', async () => {
    const { obs, calls } = await connectedObs(aitum());
    await assert.rejects(run({ type: 'obs-scene', scene: 'Pause', verticalScene: 'Typo' }, obs), /Typo/);
    assert.equal(requests(calls, 'SetCurrentProgramScene').length, 0);
    assert.equal(obs.state.currentScene, 'Game');
  });

  test('without the plugin, the horizontal part still runs, with a warning', async () => {
    const { obs, calls } = await connectedObs();
    const result = await run({ type: 'obs-scene', scene: 'Pause', verticalScene: 'V-Game' }, obs);
    assert.match(result.warning, /Aitum Vertical/);
    assert.equal(requests(calls, 'SetCurrentProgramScene').length, 1);
  });

  test('without the plugin, a vertical-only key fails', async () => {
    const { obs } = await connectedObs();
    await assert.rejects(run({ type: 'obs-scene', verticalScene: 'V-Game' }, obs), /Aitum Vertical/);
  });

  test('an empty key reports the missing scene', async () => {
    const { obs } = await connectedObs();
    await assert.rejects(run({ type: 'obs-scene' }, obs), /Scene/);
  });
});

test.describe('source keys', () => {
  const canvases = {
    GetCanvasList: () => ({
      canvases: [
        { canvasName: 'Main', canvasUuid: 'main' },
        { canvasName: 'Aitum Vertical', canvasUuid: 'aitum' },
      ],
    }),
    GetSceneList: ({ canvasUuid }) => ({ scenes: [{ sceneName: canvasUuid === 'aitum' ? 'V-Start' : 'Game' }] }),
    GetSceneItemId: () => ({ sceneItemId: 7 }),
    GetSceneItemEnabled: () => ({ sceneItemEnabled: false }),
  };

  test('shows the source in the current scene by default', async () => {
    const { obs, calls } = await connectedObs(canvases);
    await run({ type: 'obs-source', source: 'Alert', mode: 'show' }, obs);
    assert.deepEqual(requests(calls, 'SetSceneItemEnabled').map(([, d]) => [d.sceneName, d.sceneItemEnabled]), [['Game', true]]);
  });

  test('animates the horizontal and vertical sources together', async () => {
    const { obs, calls } = await connectedObs({ ...aitum(), ...canvases });
    await run({ type: 'obs-source', source: 'Alert', verticalSource: 'Alert V', mode: 'show' }, obs);
    const enabled = requests(calls, 'SetSceneItemEnabled').map(([, d]) => d.canvasUuid ?? 'main');
    assert.deepEqual(enabled.sort(), ['aitum', 'main']);
  });

  test('toggle puts both canvases in the same state', async () => {
    const { obs, calls } = await connectedObs({ ...aitum(), ...canvases });
    await run({ type: 'obs-source', source: 'Alert', verticalSource: 'Alert V', mode: 'toggle' }, obs);
    assert.equal(requests(calls, 'GetSceneItemEnabled').length, 1);
    assert.deepEqual(requests(calls, 'SetSceneItemEnabled').map(([, d]) => d.sceneItemEnabled), [true, true]);
  });

  test('flash hides the source again after the duration', async () => {
    const { obs, calls } = await connectedObs(canvases);
    await run({ type: 'obs-source', source: 'Alert', mode: 'flash', duration: 0.02 }, obs);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(requests(calls, 'SetSceneItemEnabled').map(([, d]) => d.sceneItemEnabled), [false, true, false]);
  });

  test('vertical sources need OBS 32 (canvas support)', async () => {
    const { obs } = await connectedObs({ ...aitum(), GetCanvasList: () => Promise.reject(new Error('Unknown request')) });
    await assert.rejects(run({ type: 'obs-source', verticalSource: 'Alert V', mode: 'show' }, obs), /OBS 32/);
  });
});

test.describe('mute keys', () => {
  const inputs = {
    GetInputList: () => ({ inputs: [{ inputName: 'Mic' }, { inputName: 'Webcam' }, { inputName: 'Music' }] }),
    GetInputMute: ({ inputName }) => {
      if (inputName === 'Webcam') throw new Error('Not an audio input');
      return { inputMuted: inputName === 'Music' };
    },
    ToggleInputMute: () => ({ inputMuted: true }),
  };

  test('lists only audio inputs, with their mute state', async () => {
    const { obs } = await connectedObs(inputs);
    assert.deepEqual(obs.state.mutedInputs, { Mic: false, Music: true });
  });

  test('toggles, mutes and unmutes', async () => {
    const { obs, calls } = await connectedObs(inputs);
    await run({ type: 'obs-mute', input: 'Mic' }, obs);
    assert.equal(obs.state.mutedInputs.Mic, true);
    await run({ type: 'obs-mute', input: 'Mic', mode: 'unmute' }, obs);
    assert.equal(obs.state.mutedInputs.Mic, false);
    assert.deepEqual(requests(calls, 'SetInputMute').at(-1)[1], { inputName: 'Mic', inputMuted: false });
  });

  test('follows mute changes made in OBS', async () => {
    const { obs } = await connectedObs(inputs);
    obs.ws.emit('InputMuteStateChanged', { inputName: 'Mic', inputMuted: true });
    assert.equal(obs.state.mutedInputs.Mic, true);
    obs.ws.emit('InputNameChanged', { oldInputName: 'Mic', inputName: 'Microphone' });
    assert.deepEqual(Object.keys(obs.state.mutedInputs).sort(), ['Microphone', 'Music']);
  });

  test('reports an unknown input', async () => {
    const { obs } = await connectedObs(inputs);
    await assert.rejects(run({ type: 'obs-mute', input: 'Nope' }, obs), /Nope/);
  });
});

test.describe('clip keys', () => {
  const replayOn = { GetReplayBufferStatus: () => ({ outputActive: true }) };

  test('saves the replay buffer and confirms it', async () => {
    const { obs, calls } = await connectedObs(replayOn);
    const result = await run({ type: 'obs-replay' }, obs);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 1);
    assert.match(result.notice, /saved/i);
  });

  test('saves horizontal and vertical clips together', async () => {
    const { obs, calls } = await connectedObs({ ...aitum(), ...replayOn });
    await run({ type: 'obs-replay', target: 'both' }, obs);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 1);
    assert.equal(vendorRequests(calls, 'save_backtrack').length, 1);
  });

  test('a vertical-only clip uses the Backtrack alone', async () => {
    const { obs, calls } = await connectedObs({ ...aitum(), ...replayOn });
    await run({ type: 'obs-replay', target: 'vertical' }, obs);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 0);
    assert.equal(vendorRequests(calls, 'save_backtrack').length, 1);
  });

  test('a buffer that is not started is reported, never started for the user', async () => {
    const { obs, calls } = await connectedObs({ GetReplayBufferStatus: () => ({ outputActive: false }) });
    await assert.rejects(run({ type: 'obs-replay' }, obs), /not started/i);
    assert.equal(requests(calls, 'StartReplayBuffer').length, 0);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 0);
  });

  test('with the Backtrack off, saves neither clip (both canvases stay in step)', async () => {
    const { obs, calls } = await connectedObs({ ...aitum({ backtrack: false }), ...replayOn });
    await assert.rejects(run({ type: 'obs-replay', target: 'both' }, obs), /Backtrack/);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 0);
    assert.equal(vendorRequests(calls, 'start_backtrack').length, 0);
  });

  test('explains where to enable the replay buffer', async () => {
    const { obs } = await connectedObs({ GetReplayBufferStatus: () => Promise.reject(new Error('Not available')) });
    await assert.rejects(run({ type: 'obs-replay' }, obs), /Settings › Output/);
  });

  test('without the plugin, "both" saves the horizontal clip with a warning', async () => {
    const { obs, calls } = await connectedObs(replayOn);
    const result = await run({ type: 'obs-replay', target: 'both' }, obs);
    assert.equal(requests(calls, 'SaveReplayBuffer').length, 1);
    assert.match(result.warning, /Aitum Vertical/);
  });
});

test.describe('stream and record outputs', () => {
  const vertical = (status) => ({ ...aitum(), 'vendor:status': () => ({ responseData: { success: true, ...status } }) });

  test('horizontal only: the usual OBS toggle', async () => {
    const { obs, calls } = await connectedObs(aitum());
    await run({ type: 'obs-stream' }, obs);
    assert.equal(requests(calls, 'ToggleStream').length, 1);
    assert.equal(vendorRequests(calls, 'toggle_streaming').length, 0);
  });

  test('vertical only: Aitum toggles its own stream / recording', async () => {
    const { obs, calls } = await connectedObs(aitum());
    await run({ type: 'obs-stream', target: 'vertical' }, obs);
    await run({ type: 'obs-record', target: 'vertical' }, obs);
    assert.equal(vendorRequests(calls, 'toggle_streaming').length, 1);
    assert.equal(vendorRequests(calls, 'toggle_recording').length, 1);
    assert.equal(requests(calls, 'ToggleStream').length, 0);
  });

  test('both, nothing running: starts both', async () => {
    const { obs, calls } = await connectedObs({ ...vertical({ streaming: false }), GetStreamStatus: () => ({ outputActive: false }) });
    await run({ type: 'obs-stream', target: 'both' }, obs);
    assert.equal(requests(calls, 'StartStream').length, 1);
    assert.equal(vendorRequests(calls, 'start_streaming').length, 1);
  });

  test('both, horizontal running: stops it, never starts the vertical one', async () => {
    const recording = { outputActive: true, outputDuration: 1000 };
    const { obs, calls } = await connectedObs({ ...vertical({ recording: false }), GetRecordStatus: () => recording });
    await run({ type: 'obs-record', target: 'both' }, obs);
    assert.equal(requests(calls, 'StopRecord').length, 1);
    assert.equal(vendorRequests(calls, 'start_recording').length, 0);
    assert.equal(vendorRequests(calls, 'stop_recording').length, 0);
  });

  test('both, only the vertical running: starts the horizontal one, leaves the vertical on', async () => {
    const { obs, calls } = await connectedObs({ ...vertical({ streaming: true }), GetStreamStatus: () => ({ outputActive: false }) });
    await run({ type: 'obs-stream', target: 'both' }, obs);
    assert.equal(requests(calls, 'StartStream').length, 1);
    assert.equal(vendorRequests(calls, 'start_streaming').length, 0);
    assert.equal(vendorRequests(calls, 'stop_streaming').length, 0);
  });

  test('follows the vertical stream started or stopped in Aitum', async () => {
    const { obs } = await connectedObs(aitum());
    obs.ws.emit('VendorEvent', { vendorName: 'aitum-vertical-canvas', eventType: 'streaming_started', eventData: {} });
    assert.ok(obs.state.verticalStreamingSince);
    obs.ws.emit('VendorEvent', { vendorName: 'aitum-vertical-canvas', eventType: 'streaming_stopped', eventData: {} });
    assert.equal(obs.state.verticalStreamingSince, null);
  });

  test('without the plugin, "both" toggles the horizontal output with a warning', async () => {
    const { obs, calls } = await connectedObs();
    const result = await run({ type: 'obs-record', target: 'both' }, obs);
    assert.equal(requests(calls, 'ToggleRecord').length, 1);
    assert.match(result.warning, /Aitum Vertical/);
  });
});

test.describe('stream and recording state', () => {
  const STATE = (name) => `OBS_WEBSOCKET_OUTPUT_${name}`;

  test('picks up a stream already running when connecting', async () => {
    const { obs } = await connectedObs({ GetStreamStatus: () => ({ outputActive: true, outputDuration: 60000 }) });
    assert.ok(Math.abs(Date.now() - 60000 - obs.state.streamingSince) < 1000);
  });

  test('a stream reconnecting keeps its timer; only a stop clears it', async () => {
    const { obs } = await connectedObs();
    obs.ws.emit('StreamStateChanged', { outputActive: true, outputState: STATE('STARTED') });
    const since = obs.state.streamingSince;
    assert.ok(since);
    obs.ws.emit('StreamStateChanged', { outputActive: false, outputState: STATE('RECONNECTING') });
    assert.equal(obs.state.streamingSince, since);
    obs.ws.emit('StreamStateChanged', { outputActive: false, outputState: STATE('STOPPED') });
    assert.equal(obs.state.streamingSince, null);
  });

  test('a paused recording stays on the key, with its time frozen, then resumes without drift', async () => {
    // OBS's reported duration lags behind (encoder delay): it must not be used after a pause.
    const { obs, calls } = await connectedObs({ GetRecordStatus: () => ({ outputActive: false }) });
    obs.ws.emit('RecordStateChanged', { outputActive: true, outputState: STATE('STARTED') });
    const recorded = 30000;
    obs.state.recordingSince = Date.now() - recorded; // 30 s of recording so far

    // OBS flags a paused output as not active: the state name is what counts.
    obs.ws.emit('RecordStateChanged', { outputActive: false, outputState: STATE('PAUSED') });
    assert.equal(obs.state.recordingPaused, true);
    assert.ok(Math.abs(obs.state.recordingPausedAt - obs.state.recordingSince - recorded) < 50);

    // The pause lasted 10 s: as if everything so far had happened 10 s earlier.
    obs.state.recordingSince -= 10000;
    obs.state.recordingPausedAt -= 10000;
    obs.ws.emit('RecordStateChanged', { outputActive: true, outputState: STATE('RESUMED') });
    assert.equal(obs.state.recordingPaused, false);
    // Still 30 s recorded: the 10 s pause doesn't count.
    assert.ok(Math.abs(Date.now() - obs.state.recordingSince - recorded) < 50);
    assert.equal(requests(calls, 'GetRecordStatus').length, 1); // only at connection

    obs.ws.emit('RecordStateChanged', { outputActive: false, outputState: STATE('STOPPED') });
    assert.equal(obs.state.recordingSince, null);
  });
});

test.describe('other keys', () => {
  test('stream and record keys toggle the outputs', async () => {
    const { obs, calls } = await connectedObs();
    await run({ type: 'obs-stream' }, obs);
    await run({ type: 'obs-record' }, obs);
    assert.equal(requests(calls, 'ToggleStream').length, 1);
    assert.equal(requests(calls, 'ToggleRecord').length, 1);
  });

  test('sound keys play the file at the chosen volume', async () => {
    const played = [];
    await run({ type: 'sound', file: 'C:\\sounds\\horn.mp3', volume: 0.5 }, null, {
      playSound: (file, volume) => played.push([file, volume]),
    });
    assert.deepEqual(played, [['C:\\sounds\\horn.mp3', 0.5]]);
  });

  test('open keys send links to the browser and paths to Windows', async (t) => {
    const opened = [];
    t.mock.method(electron.shell, 'openExternal', async (url) => opened.push(['link', url]));
    t.mock.method(electron.shell, 'openPath', async (p) => opened.push(['path', p]) && '');
    await run({ type: 'open', target: 'https://twitch.tv' }, null);
    await run({ type: 'open', target: 'C:\\Games\\game.exe' }, null);
    assert.deepEqual(opened, [
      ['link', 'https://twitch.tv'],
      ['path', 'C:\\Games\\game.exe'],
    ]);
  });

  test('open keys report a target Windows cannot open', async (t) => {
    t.mock.method(electron.shell, 'openPath', async () => 'File not found');
    await assert.rejects(run({ type: 'open', target: 'C:\\missing.exe' }, null), /File not found/);
  });

  test('Hue keys go to the bridge, without waiting for OBS', async () => {
    const sent = [];
    const action = { type: 'hue', light: 'id', lightKind: 'room', mode: 'toggle' };
    await run(action, null, { hue: async (a) => sent.push(a) });
    assert.deepEqual(sent, [action]);
    assert.equal(needsStream(action), false);
    const offline = async () => {
      throw new Error('The Hue bridge does not answer.');
    };
    await assert.rejects(run(action, null, { hue: offline }), /does not answer/);
  });

  test('Govee keys go to the lights, without waiting for OBS', async () => {
    const sent = [];
    const action = { type: 'govee', device: 'all', mode: 'on' };
    await run(action, null, { govee: async (a) => sent.push(a) });
    assert.deepEqual(sent, [action]);
    assert.equal(needsStream(action), false);
  });
});

test.describe('multi-action keys', () => {
  test('runs the steps in order, waiting before the ones that ask for it', async () => {
    const { obs, calls } = await connectedObs();
    const played = [];
    const started = Date.now();
    await run(
      {
        type: 'multi',
        steps: [
          { delay: 0, action: { type: 'obs-scene', scene: 'Pause' } },
          { delay: 0.05, action: { type: 'sound', file: 'music.mp3', volume: 1 } },
        ],
      },
      obs,
      { playSound: (file) => played.push([file, Date.now() - started]) },
    );
    assert.deepEqual(requests(calls, 'SetCurrentProgramScene').map(([, d]) => d.sceneName), ['Pause']);
    assert.equal(played[0][0], 'music.mp3');
    assert.ok(played[0][1] >= 45, `the sound waited ${played[0][1]} ms`);
  });

  test('a failing step does not stop the next ones, and is reported', async () => {
    const { obs, calls } = await connectedObs();
    await assert.rejects(
      run(
        {
          type: 'multi',
          steps: [
            { action: { type: 'obs-mute', input: 'Nope' } },
            { action: { type: 'obs-scene', scene: 'Pause' } },
          ],
        },
        obs,
      ),
      /Step 1: .*Nope/,
    );
    assert.equal(requests(calls, 'SetCurrentProgramScene').length, 1);
  });

  test('passes on the confirmation of a step (e.g. a saved clip)', async () => {
    const { obs } = await connectedObs({ GetReplayBufferStatus: () => ({ outputActive: true }) });
    const result = await run({ type: 'multi', steps: [{ action: { type: 'obs-replay' } }] }, obs);
    assert.match(result.notice, /saved/i);
  });

  test('an empty multi-action is reported; nested ones are skipped', async () => {
    const { obs } = await connectedObs();
    await assert.rejects(run({ type: 'multi', steps: [] }, obs), /no steps/);
    const result = await run({ type: 'multi', steps: [{ action: { type: 'multi', steps: [] } }] }, obs);
    assert.deepEqual(result, { warning: null, notice: null, page: null });
  });
});

test.describe('page keys', () => {
  test('ask the deck to change page (next by default)', async () => {
    assert.deepEqual(await run({ type: 'page' }, null), { page: 'next' });
    assert.deepEqual(await run({ type: 'page', page: '3' }, null), { page: '3' });
  });

  test('a multi-action can end on a page', async () => {
    const { obs } = await connectedObs();
    const result = await run(
      { type: 'multi', steps: [{ action: { type: 'obs-scene', scene: 'Pause' } }, { action: { type: 'page', page: '2' } }] },
      obs,
    );
    assert.equal(result.page, '2');
  });
});

test('only keys driving OBS / Streamlabs wait for a connection attempt', () => {
  for (const type of ['obs-scene', 'obs-source', 'obs-mute', 'obs-replay', 'obs-record', 'obs-stream']) {
    assert.ok(needsStream({ type }), type);
  }
  for (const type of ['sound', 'open', 'page', 'none']) assert.ok(!needsStream({ type }), type);
  assert.ok(needsStream({ type: 'multi', steps: [{ action: { type: 'sound' } }, { action: { type: 'obs-scene' } }] }));
  assert.ok(!needsStream({ type: 'multi', steps: [{ action: { type: 'sound' } }, { action: { type: 'page' } }] }));
  assert.ok(!needsStream({ type: 'multi', steps: [{}, null] }));
  assert.ok(!needsStream(undefined));
});

test.describe('keyboard keys', () => {
  // What the keys ask of keyboard.js (main.js passes it in the context).
  const recorder = () => {
    const calls = [];
    const keyboard = {
      media: async (...args) => calls.push(['media', ...args]),
      combo: async (...args) => calls.push(['combo', ...args]),
      text: async (...args) => calls.push(['text', ...args]),
    };
    const microphone = (mode) => (calls.push(['mic', mode]), { notice: 'muted' });
    return { calls, context: { keyboard, microphone } };
  };

  test("the PC's microphone, not a key press", async () => {
    const { calls, context } = recorder();
    assert.deepEqual(await run({ type: 'media', key: 'micMute' }, null, context), { notice: 'muted' });
    await run({ type: 'media', key: 'micMute', mode: 'unmute' }, null, context);
    assert.deepEqual(calls, [['mic', 'toggle'], ['mic', 'unmute']]);
  });

  test('media keys, volume keys moving several steps', async () => {
    const { calls, context } = recorder();
    await run({ type: 'media', key: 'next', repeat: 5 }, null, context);
    await run({ type: 'media', key: 'volumeUp', repeat: 5 }, null, context);
    await run({ type: 'media' }, null, context);
    assert.deepEqual(calls, [['media', 'next', 1], ['media', 'volumeUp', 5], ['media', 'playPause', 1]]);
  });

  test('a key combination', async () => {
    const { calls, context } = recorder();
    await run({ type: 'keys', keys: 'Control+Shift+M' }, null, context);
    assert.deepEqual(calls, [['combo', 'Control+Shift+M']]);
    await assert.rejects(run({ type: 'keys', keys: '' }, null, context), /Keys to send/);
  });

  test('a text, with or without Enter', async () => {
    const { calls, context } = recorder();
    await run({ type: 'text', text: 'GG', enter: true }, null, context);
    await run({ type: 'text', text: 'hi', enter: 'yes' }, null, context);
    assert.deepEqual(calls, [['text', 'GG', { enter: true }], ['text', 'hi', { enter: false }]]);
    await assert.rejects(run({ type: 'text' }, null, context), /Text/);
  });
});

test('only keys that type need the window the deck opened over', () => {
  for (const type of ['keys', 'text']) assert.ok(needsFocus({ type }), type);
  for (const type of ['media', 'sound', 'open', 'obs-scene', 'page', 'none']) assert.ok(!needsFocus({ type }), type);
  assert.ok(needsFocus({ type: 'multi', steps: [{ action: { type: 'sound' } }, { action: { type: 'text' } }] }));
  assert.ok(!needsFocus({ type: 'multi', steps: [{ action: { type: 'media' } }, {}, null] }));
  assert.ok(!needsFocus(undefined));
});
