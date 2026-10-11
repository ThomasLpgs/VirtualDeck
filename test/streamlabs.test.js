// Streamlabs client, with its JSON-RPC requests answered by a fake Streamlabs Desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { StreamlabsManager } = require('../src/streamlabs');
const { runAction } = require('../src/actions');

function connectedStreamlabs(answers = {}) {
  const client = new StreamlabsManager();
  const calls = [];
  client.request = async (resource, method, ...args) => {
    calls.push([resource, method, ...args]);
    const answer = answers[`${resource}.${method}`];
    return typeof answer === 'function' ? answer(...args) : answer;
  };
  client.setState({ status: 'connected', mutedInputs: { Mic: false } });
  return { client, calls };
}

test('mutes an audio source through its resource', async () => {
  const { client, calls } = connectedStreamlabs({
    'AudioService.getSources': [{ name: 'Mic', muted: false, resourceId: 'AudioSource["mic"]' }],
  });
  await runAction({ type: 'obs-mute', input: 'Mic' }, { stream: client });
  assert.deepEqual(calls.at(-1), ['AudioSource["mic"]', 'setMuted', true]);
  assert.equal(client.state.mutedInputs.Mic, true);
});

test('saves a replay only when the buffer is running, never starting it', async () => {
  const running = connectedStreamlabs({ 'StreamingService.getModel': { replayBufferStatus: 'running' } });
  await runAction({ type: 'obs-replay' }, { stream: running.client });
  assert.deepEqual(running.calls.at(-1), ['StreamingService', 'saveReplay']);

  const off = connectedStreamlabs({ 'StreamingService.getModel': { replayBufferStatus: 'offline' } });
  await assert.rejects(runAction({ type: 'obs-replay' }, { stream: off.client }), /not started/i);
  assert.equal(off.calls.some(([, method]) => method === 'startReplayBuffer'), false);
});

test('vertical features are OBS-only; the horizontal part still runs', async () => {
  const { client, calls } = connectedStreamlabs({ 'ScenesService.getScenes': [{ id: 'game', name: 'Game' }] });
  await assert.rejects(runAction({ type: 'obs-scene', verticalScene: 'V' }, { stream: client }), /OBS/);
  const result = await runAction({ type: 'obs-scene', scene: 'Game', verticalScene: 'V' }, { stream: client });
  assert.match(result.warning, /OBS/);
  assert.deepEqual(calls.at(-1), ['ScenesService', 'makeSceneActive', 'game']);
});

test('routes subscribed events to their handler', () => {
  const { client } = connectedStreamlabs();
  const received = [];
  client.eventHandlers.set('sub-1', (data) => received.push(data));
  client.handleMessage(`${JSON.stringify({ result: { _type: 'EVENT', resourceId: 'sub-1', data: 'live' } })}\n`);
  assert.deepEqual(received, ['live']);
});

test('state that needs a connection is cleared on disconnection', () => {
  const { client } = connectedStreamlabs();
  client.setState({ streamingSince: Date.now() });
  client.setState({ status: 'disconnected' });
  assert.equal(client.state.streamingSince, null);
  assert.deepEqual(client.state.mutedInputs, {});
});
