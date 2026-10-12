// Philips Hue lights, through the Hue bridge of the home network (its local API: no Hue account,
// no cloud, nothing to open on the router).
//
// Security:
// - Only a bridge at a home network address (private IPv4) is ever contacted.
// - Pairing needs a press on the bridge's own button; the key it then gives is stored encrypted
//   (config.js) and only sent to that bridge.
// - Always HTTPS. The bridge's certificate is recorded at pairing and must stay the same: another
//   device taking the bridge's address later can't receive the key.
const dgram = require('dgram');
const http = require('http');
const tls = require('tls');
const { isPrivateIPv4 } = require('./remote');

const TIMEOUT_MS = 5000;
const DISCOVERY_MS = 3000;
const MAX_RESPONSE = 2 * 1024 * 1024;
// Philips' list of the bridges seen from this home's internet address, used along with the local
// network search (some routers block it). It only answers with the bridges' local addresses.
const CLOUD_DISCOVERY = 'https://discovery.meethue.com/';
const BRIDGE_ID = /^[0-9a-f]{16}$/;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_KEY = /^[A-Za-z0-9_-]{20,64}$/;
// Colour temperatures of the white presets, in mirek (1,000,000 / kelvin).
const WHITES = { warm: 370, neutral: 250, cool: 153 };
const MODES = ['toggle', 'on', 'off', 'scene'];

// Tests point these at a local fake bridge.
const network = { port: 443, isLocal: isPrivateIPv4 };

// code: what went wrong, for main.js to explain ('unreachable', 'certificate', 'linkButton'…).
class HueError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// One HTTPS request to the bridge at ip. pin: SHA-256 fingerprint its certificate must have
// ('' before pairing, to read it). Resolves to { status, data, cert }.
function bridgeRequest(ip, { method = 'GET', path, key = '', body, pin = '' }) {
  if (!network.isLocal(ip)) return Promise.reject(new HueError('address'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    // The certificate is checked before anything is sent, so the key never reaches another device.
    const socket = tls.connect({ host: ip, port: network.port, rejectUnauthorized: false });
    const timer = setTimeout(() => finish(new HueError('unreachable')), TIMEOUT_MS);
    socket.on('error', () => finish(new HueError('unreachable')));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()?.fingerprint256 || '';
      if (!cert || (pin && cert !== pin)) return finish(new HueError('certificate'));
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Host: ip, Connection: 'close' };
      if (key) headers['hue-application-key'] = key;
      if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      const req = http.request({ method, path, headers, createConnection: () => socket }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) return finish(new HueError('bridge', 'response too large'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Not JSON: left null, the callers treat it as an unexpected answer.
          }
          finish(null, { status: res.statusCode, data, cert });
        });
        res.on('error', () => finish(new HueError('unreachable')));
      });
      req.on('error', () => finish(new HueError('unreachable')));
      req.end(payload);
    });
  });
}

// Name and id of the Hue bridge at ip (no key needed), with its certificate's fingerprint.
async function bridgeInfo(ip) {
  const { data, cert } = await bridgeRequest(ip, { path: '/api/config' });
  const id = String(data?.bridgeid || '').toLowerCase();
  if (!BRIDGE_ID.test(id)) throw new HueError('notBridge');
  return { ip, id, name: String(data.name || 'Hue Bridge').slice(0, 60), cert };
}

// Asks the bridge for a key; it only gives one in the 30 seconds after its button was pressed.
// Resolves to the settings to save: { ip, id, name, cert, key }.
async function pair(ip, deviceName = 'PC') {
  const info = await bridgeInfo(ip);
  // "app#device", 40 characters at most.
  const devicetype = `VirtualDeck#${String(deviceName).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 19) || 'PC'}`;
  const { data } = await bridgeRequest(ip, { method: 'POST', path: '/api', body: { devicetype }, pin: info.cert });
  const answer = Array.isArray(data) ? data[0] : null;
  if (answer?.error?.type === 101) throw new HueError('linkButton');
  const key = answer?.success?.username;
  if (typeof key !== 'string' || !APP_KEY.test(key)) throw new HueError('bridge', answer?.error?.description || '');
  return { ...info, key };
}

// Bridge API v2 call. hue: the saved settings { ip, cert, key }. Resolves to the `data` list.
async function clip(hue, method, resource, body) {
  if (!hue?.ip || !hue.key) throw new HueError('notPaired');
  const { status, data } = await bridgeRequest(hue.ip, {
    method,
    path: `/clip/v2/resource/${resource}`,
    key: hue.key,
    body,
    pin: hue.cert,
  });
  if (status === 401 || status === 403) throw new HueError('unauthorized');
  if (status === 404) throw new HueError('notFound');
  if (status >= 400 || !data) throw new HueError('bridge', String(data?.errors?.[0]?.description || status));
  return Array.isArray(data.data) ? data.data : [];
}

// What the editor offers: every light, room and zone (and "all lights"), and the scenes.
// Rooms and zones are driven through their grouped_light; scenes belong to a room or zone (area).
async function listLights(hue) {
  const [lights, rooms, zones, groups, scenes] = await Promise.all(
    ['light', 'room', 'zone', 'grouped_light', 'scene'].map((resource) => clip(hue, 'GET', resource)),
  );
  const name = (item) => String(item?.metadata?.name || '').slice(0, 60);
  const groupOf = (item) => item.services?.find((service) => service?.rtype === 'grouped_light')?.rid;
  const areas = (list, kind) =>
    list
      .map((area) => ({ kind, id: groupOf(area), area: area.id, name: name(area) }))
      .filter((area) => RESOURCE_ID.test(area.id || ''))
      .sort((a, b) => a.name.localeCompare(b.name));
  const home = groups.find((group) => group?.owner?.rtype === 'bridge_home');
  return {
    targets: [
      ...(home ? [{ kind: 'all', id: home.id, area: '', name: '' }] : []),
      ...areas(rooms, 'room'),
      ...areas(zones, 'zone'),
      ...lights
        .map((light) => ({ kind: 'light', id: light.id, area: '', name: name(light) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ],
    scenes: scenes
      .map((scene) => ({ id: scene.id, area: String(scene.group?.rid || ''), name: name(scene) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// "#ff8800" -> CIE xy, the colour space the bridge expects (each light keeps to its own range).
function hexToXy(hex) {
  const linear = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92));
  const [r, g, b] = linear;
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  // Black has no colour: plain white instead.
  if (!sum) return { x: 0.3127, y: 0.329 };
  const round = (n) => Math.round(n * 10000) / 10000;
  return { x: round(X / sum), y: round(Y / sum) };
}

// Brightness and colour a key sets when it turns lights on (each optional).
function lookOf(action) {
  const look = {};
  const brightness = Number(action.brightness);
  if (brightness >= 1 && brightness <= 100) look.dimming = { brightness: Math.round(brightness) };
  if (WHITES[action.color]) look.color_temperature = { mirek: WHITES[action.color] };
  else if (/^#[0-9a-f]{6}$/i.test(action.color || '')) look.color = { xy: hexToXy(action.color) };
  return look;
}

// Runs a key's Hue action: { light (light or grouped_light id), lightKind ('light' | 'room' |
// 'zone' | 'all'), mode, scene, brightness, color }.
async function runHue(action, hue) {
  const mode = MODES.includes(action.mode) ? action.mode : 'toggle';
  if (mode === 'scene') {
    if (!RESOURCE_ID.test(action.scene || '')) throw new HueError('noScene');
    const { dimming } = lookOf(action);
    await clip(hue, 'PUT', `scene/${action.scene}`, { recall: { action: 'active', ...(dimming ? { dimming } : {}) } });
    return;
  }
  if (!RESOURCE_ID.test(action.light || '')) throw new HueError('noLight');
  const resource = `${action.lightKind === 'light' ? 'light' : 'grouped_light'}/${action.light}`;
  let on = mode === 'on';
  if (mode === 'toggle') {
    // A room counts as on while any of its lights is: the key then turns it off.
    const [state] = await clip(hue, 'GET', resource);
    on = !state?.on?.on;
  }
  await clip(hue, 'PUT', resource, on ? { on: { on: true }, ...lookOf(action) } : { on: { on: false } });
}

// Local network search (mDNS, "_hue._tcp.local"): addresses of the devices that answer.
// Asked from a random port, so they answer straight back to it (no shared port 5353 needed).
function searchLocal() {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket('udp4');
    const end = () => {
      try {
        socket.close();
      } catch {
        // Already closed after an error.
      }
      resolve([...found]);
    };
    const labels = ['_hue', '_tcp', 'local'].map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
    // Header (id 0, one question), the name, type PTR (12), class IN asking for a direct answer.
    const query = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...labels,
      Buffer.from([0, 0, 12, 0x80, 1]),
    ]);
    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', end);
    socket.bind(0, () => socket.send(query, 5353, '224.0.0.251', () => {}));
    setTimeout(end, DISCOVERY_MS);
  });
}

async function searchCloud() {
  try {
    const response = await fetch(CLOUD_DISCOVERY, { signal: AbortSignal.timeout(DISCOVERY_MS) });
    const list = response.ok ? await response.json() : [];
    return (Array.isArray(list) ? list : []).map((bridge) => String(bridge?.internalipaddress || ''));
  } catch {
    return [];
  }
}

// Hue bridges on the home network: [{ ip, id, name, cert }]. Each address found is checked by
// asking it directly, so only real bridges of the local network are listed.
async function discover() {
  const addresses = [...new Set((await Promise.all([searchLocal(), searchCloud()])).flat())].filter(network.isLocal);
  const bridges = await Promise.all(addresses.map((ip) => bridgeInfo(ip).catch(() => null)));
  const byId = new Map();
  for (const bridge of bridges) if (bridge && !byId.has(bridge.id)) byId.set(bridge.id, bridge);
  return [...byId.values()];
}

module.exports = { HueError, bridgeInfo, pair, listLights, runHue, discover, hexToXy, network };
