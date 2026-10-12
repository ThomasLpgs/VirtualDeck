// Phone as a deck: a small web server on the home network that a phone opens by scanning a QR code.
//
// Security (nothing here is reachable from the internet):
// - Off by default; it only listens while the setting is on, on the PC's local network address
//   only (not on VPN / virtual adapters), and never touches the router (no UPnP, no cloud).
// - Only devices of the local network are answered (private IPv4 addresses), and only for our own
//   address in the Host header, so a web page on another site can't reach it (DNS rebinding).
// - Pairing key: 32 random bytes, in the QR code's #fragment, which browsers never send. Every
//   API call is signed with it (HMAC-SHA256 over the body, with a timestamp and a single-use
//   nonce): a device on the Wi-Fi without the key can't press a key, even by replaying a request.
// - Too many bad signatures from one address: that address is ignored for a while.
// - The served files are a fixed list; no path from the request ever reaches the disk.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAX_BODY = 8 * 1024;
// Accepted gap between the phone's clock and the PC's (the phone corrects its own from replies).
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const NONCE_TTL_MS = 2 * MAX_CLOCK_SKEW_MS;
const WAIT_MS = 25 * 1000;
const MAX_WAITERS = 16;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 10 * 60 * 1000;
// A phone counts as connected while it polls (it does every WAIT_MS at most).
const SEEN_MS = WAIT_MS + 15 * 1000;

const STATIC = {
  '/': ['src/phone/index.html', 'text/html'],
  '/phone.js': ['src/phone/phone.js', 'text/javascript'],
  '/phone.css': ['src/phone/phone.css', 'text/css'],
  '/shared/i18n.js': ['src/shared/i18n.js', 'text/javascript'],
  '/shared/keys.js': ['src/shared/keys.js', 'text/javascript'],
  '/shared/keys.css': ['src/shared/keys.css', 'text/css'],
  '/shared/hmac.js': ['src/shared/hmac.js', 'text/javascript'],
  '/icon.png': ['src/assets/icon.png', 'image/png'],
  '/node_modules/@fontsource-variable/inter/index.css': ['node_modules/@fontsource-variable/inter/index.css', 'text/css'],
};
const ICON = /^\/node_modules\/lucide-static\/icons\/([a-z0-9-]+)\.svg$/;
const FONT = /^\/node_modules\/@fontsource-variable\/inter\/files\/([a-z0-9-]+)\.woff2$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const VIRTUAL_ADAPTER = /virtual|vethernet|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|vpn|tap-|tun/i;

function isPrivateIPv4(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// The PC's address on the home network (from os.networkInterfaces()), or null.
// Real adapters (Wi-Fi, Ethernet) win over virtual ones; 192.168.x.x is the usual home network.
function pickLanAddress(interfaces) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const entry of addresses || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal || !isPrivateIPv4(entry.address)) continue;
      const score = (VIRTUAL_ADAPTER.test(name) ? 0 : 2) + (entry.address.startsWith('192.168.') ? 1 : 0);
      candidates.push({ address: entry.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || null;
}

const newKey = () => crypto.randomBytes(32).toString('base64url');
const isKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);

// handlers: { key() -> base64url key, state() -> object, i18n() -> object,
//             press(index) -> Promise<result>, image(index) -> { mime, data } | null }
// isLocal: which client addresses are answered (tests use the loopback address).
function createRemoteServer(handlers, { isLocal = isPrivateIPv4 } = {}) {
  let server = null;
  let host = null;
  let port = 0;
  let version = 1;
  let waiters = [];
  const nonces = new Map();
  const failures = new Map();
  const seen = new Map();

  const now = () => Date.now();

  function send(res, status, body, type = 'application/json') {
    const data = type === 'application/json' ? JSON.stringify(body) : body;
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  }

  function blocked(ip) {
    const entry = failures.get(ip);
    return Boolean(entry?.blockedUntil && entry.blockedUntil > now());
  }

  function fail(ip) {
    const entry = failures.get(ip);
    const fresh = !entry || now() - entry.since > FAILURE_WINDOW_MS;
    const next = fresh ? { since: now(), count: 1, blockedUntil: 0 } : { ...entry, count: entry.count + 1 };
    if (next.count >= MAX_FAILURES) next.blockedUntil = now() + BLOCK_MS;
    failures.set(ip, next);
  }

  function prune() {
    for (const [nonce, expires] of nonces) if (expires < now()) nonces.delete(nonce);
    for (const [ip, at] of seen) if (now() - at > SEEN_MS) seen.delete(ip);
    for (const [ip, entry] of failures) {
      if (now() - entry.since > FAILURE_WINDOW_MS && entry.blockedUntil < now()) failures.delete(ip);
    }
  }

  function serveStatic(pathname, res) {
    let file;
    let type;
    if (STATIC[pathname]) [file, type] = STATIC[pathname];
    else if (ICON.test(pathname)) [file, type] = [`node_modules/lucide-static/icons/${ICON.exec(pathname)[1]}.svg`, 'image/svg+xml'];
    else if (FONT.test(pathname)) [file, type] = [`node_modules/@fontsource-variable/inter/files/${FONT.exec(pathname)[1]}.woff2`, 'font/woff2'];
    else if (pathname === '/i18n.json') return send(res, 200, handlers.i18n());
    else return send(res, 404, { error: 'not-found' });
    fs.readFile(path.join(ROOT, file), (err, data) => {
      if (err) return send(res, 404, { error: 'not-found' });
      const binary = type === 'image/png' || type === 'font/woff2';
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': binary ? type : `${type}; charset=utf-8` });
      res.end(data);
    });
  }

  // Checks the signature, the timestamp and the nonce of an API call. Returns the parsed body or
  // { error } (then the reply status).
  function verify(raw, signature, ip) {
    const key = handlers.key();
    const expected = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(raw).digest();
    const given = Buffer.from(/^[0-9a-f]{64}$/.test(signature || '') ? signature : '', 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      fail(ip);
      return { error: 'unpaired', status: 401 };
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { error: 'bad-request', status: 400 };
    }
    if (!Number.isFinite(body?.ts) || Math.abs(now() - body.ts) > MAX_CLOCK_SKEW_MS) {
      return { error: 'clock', status: 401 };
    }
    if (typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.nonce) || nonces.has(body.nonce)) {
      return { error: 'replay', status: 401 };
    }
    nonces.set(body.nonce, now() + NONCE_TTL_MS);
    return { body };
  }

  function snapshot() {
    return { version, ...handlers.state() };
  }

  function wait(since, res) {
    if (since !== version) return send(res, 200, snapshot());
    // Never let polls pile up: the oldest one gets an "unchanged" reply right away.
    if (waiters.length >= MAX_WAITERS) waiters.shift().done();
    const waiter = {
      done: () => {
        clearTimeout(waiter.timer);
        waiters = waiters.filter((w) => w !== waiter);
        if (!res.writableEnded) send(res, 200, since === version ? { version } : snapshot());
      },
    };
    waiter.timer = setTimeout(waiter.done, WAIT_MS);
    res.on('close', () => {
      clearTimeout(waiter.timer);
      waiters = waiters.filter((w) => w !== waiter);
    });
    waiters.push(waiter);
  }

  async function api(body, res) {
    const index = Number.isInteger(body.index) && body.index >= 0 ? body.index : null;
    switch (body.op) {
      case 'hello':
        return send(res, 200, snapshot());
      case 'wait':
        return wait(body.since, res);
      case 'press':
        if (index === null) return send(res, 400, { error: 'bad-request' });
        return send(res, 200, await handlers.press(index));
      case 'image': {
        const image = index === null ? null : await handlers.image(index);
        return image ? send(res, 200, image) : send(res, 404, { error: 'not-found' });
      }
      default:
        return send(res, 400, { error: 'bad-request' });
    }
  }

  function onRequest(req, res) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    // Outside the home network, or our own address not asked for by name: no answer at all.
    if (!isLocal(ip) || req.headers.host !== `${host}:${port}`) {
      req.socket.destroy();
      return;
    }
    if (blocked(ip)) return send(res, 429, { error: 'blocked' });
    const { pathname } = new URL(req.url, `http://${host}:${port}`);

    if (req.method === 'GET') return serveStatic(pathname, res);
    if (req.method !== 'POST' || pathname !== '/api') return send(res, 405, { error: 'method' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}:${port}`) return send(res, 403, { error: 'origin' });

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      prune();
      const checked = verify(Buffer.concat(chunks).toString('utf8'), req.headers['x-signature'], ip);
      if (checked.error) return send(res, checked.status, { error: checked.error, now: now() });
      seen.set(ip, now());
      api(checked.body, res).catch((err) => send(res, 500, { error: err.message }));
    });
  }

  return {
    // Starts listening on address:wantedPort (0 for any free port). Resolves with the port used.
    start(address, wantedPort = 0) {
      return new Promise((resolve, reject) => {
        const attempt = (tryPort) => {
          const candidate = http.createServer(onRequest);
          candidate.headersTimeout = 10 * 1000;
          candidate.requestTimeout = WAIT_MS + 10 * 1000;
          candidate.once('error', (err) => {
            // The saved port is taken by something else: any free port will do.
            if (err.code === 'EADDRINUSE' && tryPort !== 0) attempt(0);
            else reject(err);
          });
          candidate.listen(tryPort, address, () => {
            server = candidate;
            host = address;
            port = candidate.address().port;
            resolve(port);
          });
        };
        attempt(wantedPort);
      });
    },
    stop() {
      for (const waiter of [...waiters]) waiter.done();
      waiters = [];
      if (server) {
        server.close();
        server.closeAllConnections?.();
      }
      server = null;
      host = null;
      seen.clear();
    },
    // The deck changed (config or OBS state): waiting phones get the new state.
    changed() {
      version += 1;
      for (const waiter of [...waiters]) waiter.done();
    },
    running: () => Boolean(server),
    address: () => (server ? { host, port } : null),
    phones: () => {
      prune();
      return seen.size;
    },
  };
}

module.exports = { createRemoteServer, pickLanAddress, isPrivateIPv4, newKey, isKey };
