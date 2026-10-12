// Govee lights, through their local network API ("LAN Control", turned on per light in the Govee
// Home app): no Govee account, no cloud, nothing to open on the router.
//
// How it talks: a search goes to the lights' multicast address (port 4001), they answer to the
// PC's port 4002 and take commands on their port 4003. Port 4002 is only listened to while a key
// runs or a search is on (a few seconds). Windows lets answers in for 3 seconds after a search
// sent from that port, so no firewall rule is needed: every key starts with a search, which also
// finds a light the router gave a new address to.
//
// Security: only home network addresses (private IPv4) are listened to or sent to.
const dgram = require('dgram');
const os = require('os');
const { isPrivateIPv4, pickLanAddress } = require('./remote');

const SEARCH_MS = 2000;
// "All lights": how long to wait for the others once the first one answered.
const ALL_GRACE_MS = 600;
// Asked twice at most: both tries stay within the 3 seconds Windows lets answers in.
const STATUS_MS = 800;
// Answers kept per search: a device flooding the port can't make it grow.
const MAX_ANSWERS = 64;
// Pause between the commands of one key (some lights drop commands sent back to back).
const COMMAND_GAP_MS = 40;
const MAX_MESSAGE = 4096;
const DEVICE_ID = /^[0-9A-F]{2}(:[0-9A-F]{2}){5,7}$/;
const SKU = /^[A-Z0-9]{3,12}$/i;
// Colour temperatures of the white presets, in kelvin.
const WHITES = { warm: 2700, neutral: 4000, cool: 6500 };
const MODES = ['toggle', 'on', 'off'];

// Tests point these at local fake lights.
const network = {
  group: '239.255.255.250',
  searchPort: 4001,
  replyPort: 4002,
  commandPort: 4003,
  isLocal: isPrivateIPv4,
  lanAddress: () => pickLanAddress(os.networkInterfaces()),
};

// code: what went wrong, for main.js to explain ('notFound', 'noLight', 'noStatus', 'network',
// 'port').
class GoveeError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One exchange at a time: they all listen on port 4002.
let queue = Promise.resolve();
function exclusive(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

// Listens on port 4002 during work(link), then closes it. link: { search, status, send }.
async function withLink(work) {
  // Never on all the PC's networks (VPN…): without a home network address, nothing is opened.
  const lan = network.lanAddress();
  if (!lan) throw new GoveeError('network');
  const socket = dgram.createSocket('udp4');
  const listeners = new Set();
  socket.on('message', (raw, rinfo) => {
    if (raw.length > MAX_MESSAGE || !network.isLocal(rinfo.address)) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'))?.msg;
    } catch {
      return;
    }
    if (msg && typeof msg.cmd === 'string') for (const listener of [...listeners]) listener(msg, rinfo.address);
  });
  socket.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', (err) => reject(new GoveeError('port', err.code || err.message)));
      socket.bind({ port: network.replyPort, address: lan }, resolve);
    });
    // With several network adapters, the search must leave through the home network one.
    if (/^2(2[4-9]|3\d)\./.test(network.group)) socket.setMulticastInterface(lan);
  } catch (err) {
    socket.close();
    throw err instanceof GoveeError ? err : new GoveeError('port', err.message);
  }

  const send = (ip, cmd, data, port = network.commandPort) =>
    new Promise((resolve) => socket.send(JSON.stringify({ msg: { cmd, data } }), port, ip, () => resolve()));

  // Answers to cmd ([{ data, ip }]) until enough(list) or stop(), or after ms.
  function collect(cmd, ms, enough = () => false) {
    const list = [];
    let stop;
    const done = new Promise((resolve) => {
      stop = () => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(list);
      };
      const timer = setTimeout(stop, ms);
      const listener = (msg, ip) => {
        if (msg.cmd !== cmd || list.length >= MAX_ANSWERS) return;
        list.push({ data: msg.data && typeof msg.data === 'object' ? msg.data : {}, ip });
        if (enough(list)) stop();
      };
      listeners.add(listener);
    });
    return { done, stop };
  }

  // Lights that answer: [{ id, sku, ip }]. wanted: an id to stop at, 'all' (stop shortly after
  // the first answer) or '' (the whole time, to list every light).
  async function search(wanted = '') {
    let grace = null;
    const answers = collect('scan', SEARCH_MS, (list) => {
      if (wanted === 'all') grace ??= setTimeout(() => answers.stop(), ALL_GRACE_MS);
      return Boolean(wanted) && wanted !== 'all' && list.some(({ data }) => idOf(data) === wanted);
    });
    await send(network.group, 'scan', { account_topic: 'reserve' }, network.searchPort);
    const list = await answers.done;
    clearTimeout(grace);
    const byId = new Map();
    for (const { data, ip } of list) {
      const id = idOf(data);
      if (id && !byId.has(id)) byId.set(id, { id, sku: SKU.test(data.sku || '') ? data.sku : '', ip });
    }
    return [...byId.values()];
  }

  // Whether the light at ip is on (null when it doesn't say, even when asked again).
  async function isOn(ip) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = collect('devStatus', STATUS_MS, (list) => list.some((item) => item.ip === ip));
      await send(ip, 'devStatus', {});
      const status = (await answer.done).find((item) => item.ip === ip);
      if (status) return status.data.onOff === 1;
    }
    return null;
  }

  try {
    return await work({ search, isOn, send });
  } finally {
    socket.close();
  }
}

function idOf(data) {
  const id = String(data?.device || '').toUpperCase();
  return DEVICE_ID.test(id) ? id : '';
}

// Govee lights on the home network: [{ id, sku, ip }].
function discover() {
  return exclusive(() => withLink(({ search }) => search()));
}

// "#ff8800" -> { r, g, b }.
const rgbOf = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

// Commands a key sends to turn lights on: on, then its brightness and colour (each optional).
function onCommands(action) {
  const commands = [['turn', { value: 1 }]];
  const brightness = Number(action.brightness);
  if (brightness >= 1 && brightness <= 100) commands.push(['brightness', { value: Math.round(brightness) }]);
  if (WHITES[action.color]) {
    commands.push(['colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: WHITES[action.color] }]);
  } else if (/^#[0-9a-f]{6}$/i.test(action.color || '')) {
    commands.push(['colorwc', { color: rgbOf(action.color), colorTemInKelvin: 0 }]);
  }
  return commands;
}

// Runs a key's Govee action: { device (an id, or 'all'), mode, brightness, color }.
function runGovee(action) {
  const mode = MODES.includes(action.mode) ? action.mode : 'toggle';
  const wanted = action.device === 'all' ? 'all' : String(action.device || '').toUpperCase();
  if (wanted !== 'all' && !DEVICE_ID.test(wanted)) return Promise.reject(new GoveeError('noLight'));
  return exclusive(() =>
    withLink(async ({ search, isOn, send }) => {
      const found = await search(wanted);
      const lights = wanted === 'all' ? found : found.filter((light) => light.id === wanted);
      if (!lights.length) throw new GoveeError('notFound');
      let on = mode === 'on';
      if (mode === 'toggle') {
        // Lights that are on are turned off; when all are off, they are turned on.
        const states = await Promise.all(lights.map((light) => isOn(light.ip)));
        // Not guessed: a light that is on would be turned on again instead of off.
        if (states.every((state) => state === null)) throw new GoveeError('noStatus');
        on = !states.some(Boolean);
      }
      const commands = on ? onCommands(action) : [['turn', { value: 0 }]];
      for (const [index, [cmd, data]] of commands.entries()) {
        if (index) await sleep(COMMAND_GAP_MS);
        await Promise.all(lights.map((light) => send(light.ip, cmd, data)));
      }
    }),
  );
}

module.exports = { GoveeError, discover, runGovee, onCommands, network };
