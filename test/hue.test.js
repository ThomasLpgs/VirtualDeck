const test = require('node:test');
const assert = require('node:assert/strict');
const { X509Certificate } = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const hue = require('../src/hue');

const FIXTURES = path.join(__dirname, 'fixtures');
const TLS = { key: fs.readFileSync(path.join(FIXTURES, 'hue-bridge.key')), cert: fs.readFileSync(path.join(FIXTURES, 'hue-bridge.crt')) };
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const ids = {
  desk: '11111111-1111-4111-8111-111111111111',
  room: '22222222-2222-4222-8222-222222222222',
  roomGroup: '33333333-3333-4333-8333-333333333333',
  home: '44444444-4444-4444-8444-444444444444',
  scene: '55555555-5555-4555-8555-555555555555',
};

// A fake Hue bridge (HTTPS with a self-signed certificate, like the real one) on 127.0.0.1.
// requests: every call it got, as { method, url, key, body }.
async function fakeBridge(t, { linkPressed = true, lightOn = false } = {}) {
  const requests = [];
  const resources = {
    light: [{ id: ids.desk, metadata: { name: 'Desk' }, on: { on: lightOn } }],
    room: [{ id: ids.room, metadata: { name: 'Studio' }, services: [{ rid: ids.roomGroup, rtype: 'grouped_light' }] }],
    zone: [],
    grouped_light: [
      { id: ids.roomGroup, owner: { rid: ids.room, rtype: 'room' }, on: { on: lightOn } },
      { id: ids.home, owner: { rtype: 'bridge_home' }, on: { on: lightOn } },
    ],
    scene: [{ id: ids.scene, metadata: { name: 'Live' }, group: { rid: ids.room, rtype: 'room' } }],
  };
  const server = https.createServer(TLS, (req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, key: req.headers['hue-application-key'], body });
      const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/api/config') return send(200, { name: 'Hue Bridge', bridgeid: '001788FFFE123456' });
      if (req.url === '/api' && req.method === 'POST') {
        return send(200, [linkPressed ? { success: { username: KEY } } : { error: { type: 101, description: 'link button not pressed' } }]);
      }
      const match = req.url.match(/^\/clip\/v2\/resource\/([a-z_]+)(?:\/(.+))?$/);
      if (!match) return send(404, {});
      if (req.headers['hue-application-key'] !== KEY) return send(403, { errors: [{ description: 'unauthorized user' }] });
      const [, type, id] = match;
      const list = resources[type] || [];
      return send(200, { errors: [], data: id ? list.filter((item) => item.id === id) : list });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...hue.network };
  Object.assign(hue.network, { port: server.address().port, isLocal: (ip) => ip === '127.0.0.1' });
  t.after(() => {
    Object.assign(hue.network, saved);
    server.close();
  });
  return { requests };
}

test('pairs with the bridge once its button is pressed, pinning its certificate', async (t) => {
  const bridge = await fakeBridge(t);
  const paired = await hue.pair('127.0.0.1', 'My PC!');
  assert.equal(paired.key, KEY);
  assert.equal(paired.id, '001788fffe123456');
  assert.equal(paired.cert, new X509Certificate(TLS.cert).fingerprint256);
  assert.deepEqual(bridge.requests.at(-1).body, { devicetype: 'VirtualDeck#My PC' });
});

test('says when the bridge button was not pressed', async (t) => {
  await fakeBridge(t, { linkPressed: false });
  await assert.rejects(hue.pair('127.0.0.1'), { code: 'linkButton' });
});

test('never contacts an address outside the home network', async () => {
  for (const ip of ['8.8.8.8', 'example.com', '']) {
    await assert.rejects(hue.bridgeInfo(ip), { code: 'address' }, ip);
  }
});

test('refuses a device whose certificate is not the paired bridge one', async (t) => {
  const bridge = await fakeBridge(t);
  const settings = { ip: '127.0.0.1', key: KEY, cert: 'AA:BB' };
  await assert.rejects(hue.runHue({ light: ids.desk, lightKind: 'light', mode: 'on' }, settings), { code: 'certificate' });
  // Nothing was sent: the key never left the PC.
  assert.equal(bridge.requests.length, 0);
});

test('lists lights, rooms, "all lights" and scenes', async (t) => {
  await fakeBridge(t);
  const settings = await hue.pair('127.0.0.1');
  assert.deepEqual(await hue.listLights(settings), {
    targets: [
      { kind: 'all', id: ids.home, area: '', name: '' },
      { kind: 'room', id: ids.roomGroup, area: ids.room, name: 'Studio' },
      { kind: 'light', id: ids.desk, area: '', name: 'Desk' },
    ],
    scenes: [{ id: ids.scene, area: ids.room, name: 'Live' }],
  });
});

test('turns lights on with a brightness and colour, off, toggles, and recalls scenes', async (t) => {
  const bridge = await fakeBridge(t, { lightOn: true });
  const settings = await hue.pair('127.0.0.1');
  const last = () => {
    const { method, url, body } = bridge.requests.at(-1);
    return [method, url, body];
  };

  await hue.runHue({ light: ids.desk, lightKind: 'light', mode: 'on', brightness: 40, color: 'warm' }, settings);
  assert.deepEqual(last(), [
    'PUT',
    `/clip/v2/resource/light/${ids.desk}`,
    { on: { on: true }, dimming: { brightness: 40 }, color_temperature: { mirek: 370 } },
  ]);

  await hue.runHue({ light: ids.roomGroup, lightKind: 'room', mode: 'on', color: '#ff0000' }, settings);
  assert.deepEqual(last(), [
    'PUT',
    `/clip/v2/resource/grouped_light/${ids.roomGroup}`,
    { on: { on: true }, color: { xy: hue.hexToXy('#ff0000') } },
  ]);

  // The room is on: toggling turns it off (and sends no colour).
  await hue.runHue({ light: ids.roomGroup, lightKind: 'room', mode: 'toggle', color: '#ff0000' }, settings);
  assert.deepEqual(last(), ['PUT', `/clip/v2/resource/grouped_light/${ids.roomGroup}`, { on: { on: false } }]);

  await hue.runHue({ light: ids.home, lightKind: 'all', mode: 'off' }, settings);
  assert.deepEqual(last(), ['PUT', `/clip/v2/resource/grouped_light/${ids.home}`, { on: { on: false } }]);

  await hue.runHue({ mode: 'scene', scene: ids.scene, brightness: 80 }, settings);
  assert.deepEqual(last(), ['PUT', `/clip/v2/resource/scene/${ids.scene}`, { recall: { action: 'active', dimming: { brightness: 80 } } }]);
});

test('rejects keys without a valid light or scene, and a key the bridge forgot', async (t) => {
  await fakeBridge(t);
  const settings = await hue.pair('127.0.0.1');
  const desk = { light: ids.desk, lightKind: 'light', mode: 'on' };
  await assert.rejects(hue.runHue({ ...desk, light: '../../api' }, settings), { code: 'noLight' });
  await assert.rejects(hue.runHue({ mode: 'scene', scene: '' }, settings), { code: 'noScene' });
  await assert.rejects(hue.runHue(desk, { ...settings, key: '' }), { code: 'notPaired' });
  await assert.rejects(hue.runHue(desk, { ...settings, key: 'x'.repeat(40) }), { code: 'unauthorized' });
});

test('converts colours to the CIE xy space the bridge uses', () => {
  assert.deepEqual(hue.hexToXy('#ffffff'), { x: 0.3127, y: 0.329 });
  assert.deepEqual(hue.hexToXy('#ff0000'), { x: 0.6401, y: 0.33 });
  assert.deepEqual(hue.hexToXy('#000000'), { x: 0.3127, y: 0.329 });
});
