const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { createRemoteServer, pickLanAddress, isPrivateIPv4, newKey, isKey, hidePaths } = require('../src/remote');
const { hmacSha256Hex, base64UrlToBytes } = require('../src/shared/hmac');

const HOST = '127.0.0.1';

function request(port, { method = 'GET', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, method, path, headers: { Host: `${HOST}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON (static file)
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const PHONE = 'phone-one-0123456789';

// A request signed like the phone does (shared/hmac.js).
function signed(key, payload, device = PHONE) {
  const body = JSON.stringify({ ts: Date.now(), nonce: crypto.randomBytes(18).toString('base64url'), device, ...payload });
  return { body, signature: hmacSha256Hex(base64UrlToBytes(key), body) };
}

const callApi = (port, { body, signature }) =>
  request(port, { method: 'POST', path: '/api', body, headers: { 'Content-Type': 'application/json', 'X-Signature': signature } });

async function startServer(overrides = {}) {
  const key = newKey();
  const pressed = [];
  const server = createRemoteServer(
    {
      key: () => key,
      state: () => ({ buttons: [{ label: 'Live' }], pageCount: 1 }),
      i18n: () => ({ lang: 'fr', strings: {} }),
      press: async (index) => {
        pressed.push(index);
        return { ok: true };
      },
      image: async () => null,
      allowDevice: () => true,
      ...overrides,
    },
    { isLocal: (ip) => ip === HOST },
  );
  const port = await server.start(HOST, 0);
  return { server, port, key, pressed };
}

test('only private network addresses count as local', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.16.3.4', '172.31.255.1', '::ffff:192.168.0.2']) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1', '::1', '', 'abc', '192.168.1']) assert.ok(!isPrivateIPv4(ip), ip);
  // Other spellings Windows could read as another (public) address.
  for (const ip of ['010.0.0.1', '0x0a.0.0.1', '10.0.0.1e0', '192.168.1.1 ', '10.0.0.01']) assert.ok(!isPrivateIPv4(ip), ip);
});

test('picks the Wi-Fi / Ethernet address over virtual adapters', () => {
  const interfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.48.1', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.42', internal: false },
    ],
  };
  assert.equal(pickLanAddress(interfaces), '192.168.1.42');
  assert.equal(pickLanAddress({ Ethernet: [{ family: 'IPv4', address: '82.64.1.1', internal: false }] }), null);
  assert.equal(pickLanAddress({}), null);
});

test('pairing keys are 32 random bytes', () => {
  const key = newKey();
  assert.ok(isKey(key));
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  assert.notEqual(key, newKey());
  assert.ok(!isKey('short'));
});

test('a signed call works; unsigned, forged, replayed or stale ones are refused', async () => {
  const { server, port, key, pressed } = await startServer();
  try {
    const hello = await callApi(port, signed(key, { op: 'hello' }));
    assert.equal(hello.status, 200);
    assert.equal(hello.json.buttons[0].label, 'Live');

    const press = signed(key, { op: 'press', index: 3 });
    assert.deepEqual((await callApi(port, press)).json, { ok: true });
    assert.deepEqual(pressed, [3]);
    // The same request sent again (captured on the Wi-Fi) is refused.
    const replay = await callApi(port, press);
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error, 'replay');
    assert.deepEqual(pressed, [3]);

    const unsigned = await request(port, { method: 'POST', path: '/api', body: '{"op":"press","index":1}' });
    assert.equal(unsigned.json.error, 'unpaired');
    const forged = await callApi(port, signed(newKey(), { op: 'press', index: 1 }));
    assert.equal(forged.json.error, 'unpaired');
    assert.deepEqual(pressed, [3]);

    // Old timestamp: refused, with the PC's time so the phone can fix its clock.
    const body = JSON.stringify({ ts: Date.now() - 5 * 60 * 1000, nonce: 'n'.repeat(24), op: 'hello' });
    const stale = await callApi(port, { body, signature: hmacSha256Hex(base64UrlToBytes(key), body) });
    assert.equal(stale.json.error, 'clock');
    assert.ok(Number.isFinite(stale.json.now));
  } finally {
    server.stop();
  }
});

test('too many bad signatures block the address', async () => {
  const { server, port, key } = await startServer();
  try {
    for (let i = 0; i < 10; i++) await callApi(port, signed(newKey(), { op: 'hello' }));
    const after = await callApi(port, signed(key, { op: 'hello' }));
    assert.equal(after.status, 429);
  } finally {
    server.stop();
  }
});

test('another Host name gets no answer (DNS rebinding)', async () => {
  const { server, port } = await startServer();
  try {
    await assert.rejects(request(port, { headers: { Host: `evil.example:${port}` } }));
  } finally {
    server.stop();
  }
});

test('serves the phone page with strict headers, and nothing outside its list', async () => {
  const { server, port } = await startServer();
  try {
    const page = await request(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.text, /phone\.js/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await request(port, { path: '/node_modules/lucide-static/icons/play.svg' })).status, 200);
    for (const path of ['/../package.json', '/src/main.js', '/node_modules/lucide-static/icons/..%2F..%2Fpackage.json.svg', '/package.json']) {
      assert.equal((await request(port, { path })).status, 404, path);
    }
  } finally {
    server.stop();
  }
});

test('a waiting phone gets the new state as soon as the deck changes', async () => {
  let label = 'Live';
  const { server, port, key } = await startServer({ state: () => ({ buttons: [{ label }], pageCount: 1 }) });
  try {
    const { version } = (await callApi(port, signed(key, { op: 'hello' }))).json;
    const waiting = callApi(port, signed(key, { op: 'wait', since: version }));
    setTimeout(() => {
      label = 'Scène 2';
      server.changed();
    }, 50);
    const next = (await waiting).json;
    assert.equal(next.version, version + 1);
    assert.equal(next.buttons[0].label, 'Scène 2');
  } finally {
    server.stop();
  }
});

test("the phone's HMAC matches Node's crypto", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 300]) {
    const key = crypto.randomBytes(32);
    const message = 'é'.repeat(size) + '{"op":"press"}';
    assert.equal(hmacSha256Hex(key, message), crypto.createHmac('sha256', key).update(message).digest('hex'));
  }
});

// Raw request, for targets an http client would refuse to send.
function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, HOST, () => socket.write(text));
    let reply = '';
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('close', () => resolve(reply));
    socket.on('error', () => resolve(reply));
    setTimeout(() => socket.destroy(), 1000);
  });
}

test('odd request targets are refused without crashing the server', async () => {
  const { server, port, key } = await startServer();
  try {
    for (const target of ['//[', '//evil.example/', '*']) {
      const reply = await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\n\r\n`);
      assert.ok(!reply.startsWith('HTTP/1.1 200'), target);
    }
    assert.equal((await callApi(port, signed(key, { op: 'hello' }))).status, 200);
  } finally {
    server.stop();
  }
});

test('without a valid key nobody is paired, even with an empty-key signature', async () => {
  const { server, port } = await startServer({ key: () => '' });
  try {
    const body = JSON.stringify({ ts: Date.now(), nonce: 'n'.repeat(24), op: 'press', index: 0 });
    const signature = crypto.createHmac('sha256', Buffer.alloc(0)).update(body).digest('hex');
    assert.equal((await callApi(port, { body, signature })).json.error, 'unpaired');
  } finally {
    server.stop();
  }
});

test('phones are only woken up when what they show changed', async () => {
  let label = 'Live';
  let builds = 0;
  const { server, port, key } = await startServer({
    state: () => {
      builds += 1;
      return { buttons: [{ label }], pageCount: 1 };
    },
  });
  try {
    const { version } = (await callApi(port, signed(key, { op: 'hello' }))).json;
    server.changed(); // same state: nothing to send
    const waiting = callApi(port, signed(key, { op: 'wait', since: version }));
    await new Promise((r) => setTimeout(r, 30));
    label = 'Pause';
    server.changed();
    const next = (await waiting).json;
    assert.equal(next.version, version + 1);
    assert.equal(next.buttons[0].label, 'Pause');
    assert.equal(builds, 3); // hello, the unchanged check, the change: not once per waiting phone
  } finally {
    server.stop();
  }
});

test('error messages sent to a phone keep file names but not the folders of the PC', () => {
  assert.equal(hidePaths('spawn C:\\Users\\Thomas Laspougeas\\Desktop\\jeu.exe ENOENT'), 'spawn jeu.exe ENOENT');
  assert.equal(hidePaths('Fichier introuvable : « D:\\Sons\\boom.mp3 »'), 'Fichier introuvable : « boom.mp3 »');
  assert.equal(hidePaths('Lecture de \\\\nas\\partage\\a.wav impossible'), 'Lecture de a.wav impossible');
  assert.equal(hidePaths('OBS non connecté'), 'OBS non connecté');
  assert.equal(hidePaths(undefined), undefined);
});

test('once the allowed phones are paired, another device is refused even with the key', async () => {
  const allowed = [];
  const { server, port, key } = await startServer({
    allowDevice: (id) => allowed.includes(id) || (allowed.length < 1 && allowed.push(id) > 0),
  });
  try {
    assert.equal((await callApi(port, signed(key, { op: 'hello' }))).status, 200);
    const other = await callApi(port, signed(key, { op: 'press', index: 0 }, 'phone-two-0123456789'));
    assert.equal(other.status, 403);
    assert.equal(other.json.error, 'full');
    // The first phone keeps working; a request without a device id is refused.
    assert.equal((await callApi(port, signed(key, { op: 'hello' }))).status, 200);
    assert.equal((await callApi(port, signed(key, { op: 'hello' }, ''))).status, 400);
    assert.equal(server.phones(), 1);
  } finally {
    server.stop();
  }
});
