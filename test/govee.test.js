const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const govee = require('../src/govee');

const ID = 'F6:19:D4:0E:85:86:1C:13';

const freePort = () =>
  new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });

// A fake Govee light on 127.0.0.1, answering the search and status like the real ones (from
// another port than the one it was asked on). got: every command it received, as [cmd, data].
// status: whether it answers devStatus.
async function fakeLight(t, { on = false, answers = true, status = true } = {}) {
  const got = [];
  const light = dgram.createSocket('udp4');
  const replies = dgram.createSocket('udp4');
  await Promise.all([
    new Promise((resolve) => light.bind(0, '127.0.0.1', resolve)),
    new Promise((resolve) => replies.bind(0, '127.0.0.1', resolve)),
  ]);
  const replyPort = await freePort();
  const answer = (cmd, data) => replies.send(JSON.stringify({ msg: { cmd, data } }), replyPort, '127.0.0.1');
  light.on('message', (raw) => {
    const { cmd, data } = JSON.parse(raw.toString()).msg;
    got.push([cmd, data]);
    if (!answers) return;
    if (cmd === 'scan') answer('scan', { ip: '127.0.0.1', device: ID, sku: 'H6076' });
    if (cmd === 'devStatus' && status) answer('devStatus', { onOff: on ? 1 : 0, brightness: 100 });
  });
  const saved = { ...govee.network };
  const { port } = light.address();
  Object.assign(govee.network, {
    group: '127.0.0.1',
    searchPort: port,
    commandPort: port,
    replyPort,
    isLocal: () => true,
    lanAddress: () => '127.0.0.1',
  });
  t.after(() => {
    Object.assign(govee.network, saved);
    light.close();
    replies.close();
  });
  const sent = () => got.filter(([cmd]) => cmd !== 'scan' && cmd !== 'devStatus');
  return {
    got,
    replyPort,
    // The commands received, once `count` of them arrived (the last one may still be on its way
    // when a key's promise resolves), or after a short wait when none are expected.
    commands: async (count) => {
      const deadline = Date.now() + (count ? 2000 : 100);
      while (sent().length < (count || Infinity) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return sent();
    },
  };
}

test.describe('Govee lights', () => {
  test('lists the lights that answer the search', async (t) => {
    await fakeLight(t);
    assert.deepEqual(await govee.discover(), [{ id: ID, sku: 'H6076', ip: '127.0.0.1' }]);
  });

  test('toggle turns an off light on, with its brightness and colour', async (t) => {
    const light = await fakeLight(t, { on: false });
    await govee.runGovee({ device: ID, mode: 'toggle', brightness: 50, color: '#ff7a00' });
    assert.deepEqual(await light.commands(3), [
      ['turn', { value: 1 }],
      ['brightness', { value: 50 }],
      ['colorwc', { color: { r: 255, g: 122, b: 0 }, colorTemInKelvin: 0 }],
    ]);
  });

  test('toggle turns an on light off', async (t) => {
    const light = await fakeLight(t, { on: true });
    await govee.runGovee({ device: ID, mode: 'toggle', brightness: 50 });
    assert.deepEqual(await light.commands(1), [['turn', { value: 0 }]]);
  });

  test('"all lights" and the white presets', async (t) => {
    const light = await fakeLight(t);
    await govee.runGovee({ device: 'all', mode: 'on', color: 'warm' });
    assert.deepEqual(await light.commands(2), [
      ['turn', { value: 1 }],
      ['colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 2700 }],
    ]);
  });

  test('a light that does not answer is reported, and nothing is sent to it', async (t) => {
    const light = await fakeLight(t, { answers: false });
    await assert.rejects(govee.runGovee({ device: ID, mode: 'off' }), { code: 'notFound' });
    assert.deepEqual(await light.commands(), []);
  });

  test('a key without a light is refused before anything is sent', async (t) => {
    const light = await fakeLight(t);
    await assert.rejects(govee.runGovee({ device: '', mode: 'on' }), { code: 'noLight' });
    assert.deepEqual(light.got, []);
  });

  test('answers from outside the home network are ignored', async (t) => {
    await fakeLight(t);
    govee.network.isLocal = () => false;
    assert.deepEqual(await govee.discover(), []);
  });

  test('a toggle whose light does not give its state is not guessed', async (t) => {
    const light = await fakeLight(t, { on: true, status: false });
    await assert.rejects(govee.runGovee({ device: ID, mode: 'toggle' }), { code: 'noStatus' });
    assert.deepEqual(await light.commands(), []);
    // Asked twice before giving up.
    assert.equal(light.got.filter(([cmd]) => cmd === 'devStatus').length, 2);
  });

  test('without a home network address, nothing is opened', async (t) => {
    const light = await fakeLight(t);
    govee.network.lanAddress = () => null;
    await assert.rejects(govee.runGovee({ device: ID, mode: 'on' }), { code: 'network' });
    await assert.rejects(govee.discover(), { code: 'network' });
    assert.deepEqual(light.got, []);
  });

  test('a taken answer port is reported, and the next press still works', async (t) => {
    const light = await fakeLight(t);
    const squatter = dgram.createSocket('udp4');
    await new Promise((resolve) => squatter.bind(light.replyPort, '127.0.0.1', resolve));
    await assert.rejects(govee.runGovee({ device: ID, mode: 'on' }), { code: 'port' });
    await new Promise((resolve) => squatter.close(resolve));
    await govee.runGovee({ device: ID, mode: 'on' });
    assert.deepEqual(await light.commands(1), [['turn', { value: 1 }]]);
  });

  test('brightness and colour values a light would not understand are left out', () => {
    for (const brightness of [0, 101, -5, 'abc', '']) {
      assert.deepEqual(govee.onCommands({ brightness }), [['turn', { value: 1 }]], String(brightness));
    }
    for (const color of ['#12345', 'red', '#gg0000', 'javascript:']) {
      assert.deepEqual(govee.onCommands({ color }), [['turn', { value: 1 }]], color);
    }
    assert.deepEqual(govee.onCommands({ brightness: 33.6, color: 'cool' }), [
      ['turn', { value: 1 }],
      ['brightness', { value: 34 }],
      ['colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 6500 }],
    ]);
  });

  test('presses never overlap on the shared answer port', async (t) => {
    const light = await fakeLight(t, { on: false });
    await Promise.all([govee.runGovee({ device: ID, mode: 'on' }), govee.runGovee({ device: ID, mode: 'off' })]);
    assert.deepEqual(await light.commands(2), [
      ['turn', { value: 1 }],
      ['turn', { value: 0 }],
    ]);
  });
});
