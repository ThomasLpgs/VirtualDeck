// Keyboard keys (src/keyboard.js), with a fake Windows: no key is really pressed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyboard, parseCombo, comboEvents, mediaEvents, KEYS, MEDIA } = require('../src/keyboard');

// Records what would have been sent to Windows. held: keys reported as still pressed.
function fakeSystem({ held = new Set(), accepted = true } = {}) {
  const sent = [];
  const focused = [];
  const system = {
    send: (events) => (sent.push(events), accepted ? events.length : 0),
    isDown: (vk) => held.has(vk),
    foreground: () => 'game-window',
    focus: (handle) => (focused.push(handle), true),
  };
  return { system: () => system, sent, focused, held };
}

// Same asynchronous API as Electron's clipboard. extra: other formats it holds ({ mime: data }).
function fakeClipboard(initial = 'copied before', extra = {}) {
  const clip = { text: initial, extra, writes: [] };
  const data = () => ({ ...(clip.text ? { 'text/plain': clip.text } : {}), ...clip.extra });
  return Object.assign(clip, {
    read: async () => {
      const held = data();
      return Object.keys(held).length ? [{ types: Object.keys(held), getType: async (type) => held[type] }] : [];
    },
    readText: async () => clip.text,
    writeText: async (text) => {
      clip.text = text;
      clip.extra = {};
      clip.writes.push(text);
    },
    write: async (items) => {
      clip.text = items[0].data['text/plain'] ?? '';
      clip.extra = items[0].data;
      clip.writes.push(items);
    },
    clear: () => ((clip.text = ''), (clip.extra = {}), clip.writes.push('cleared')),
  });
}

class FakeClipboardItem {
  constructor(data) {
    this.data = data;
  }
}

const vkNames = (events) => events.map(({ vk, up }) => `${up ? '-' : '+'}${vk.toString(16)}`).join(' ');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('reads the combinations the editor records', () => {
  assert.deepEqual(parseCombo('Control+Shift+M'), { modifiers: [0x11, 0x10], key: KEYS.M });
  // Modifiers are always pressed in the same order, whatever the order written.
  assert.deepEqual(parseCombo('Shift+Super+S'), { modifiers: [0x10, 0x5b], key: KEYS.S });
  assert.deepEqual(parseCombo('F13'), { modifiers: [], key: 0x7c });
  assert.deepEqual(parseCombo('Alt+Left').key, 0x25);
  assert.equal(parseCombo('Control+Shift+Escape').key, 0x1b);
  assert.equal(parseCombo('num5').key, 0x65);
});

test('refuses anything that is not a combination', () => {
  for (const bad of ['', 'Control', 'Control+', 'Hyper+A', 'Control+Control+A', 'A+B', 'constructor', 'Control+toString', null, 42]) {
    assert.equal(parseCombo(bad), null, String(bad));
  }
});

test('a combination is pressed, then released in reverse order', () => {
  assert.equal(vkNames(comboEvents(parseCombo('Control+Shift+M'))), '+11 +10 +4d -4d -10 -11');
});

test('volume keys repeat, within limits', () => {
  assert.equal(mediaEvents('volumeUp', 5).length, 10);
  assert.equal(mediaEvents('volumeUp', 1000).length, 50);
  assert.equal(mediaEvents('playPause', 'x').length, 2);
  assert.equal(mediaEvents('nope'), null);
  assert.equal(mediaEvents('toString'), null);
  assert.equal(mediaEvents('next')[0].vk, MEDIA.next);
});

test('sends a combination to Windows', async () => {
  const fake = fakeSystem();
  await createKeyboard({ system: fake.system }).combo('Control+V');
  assert.equal(vkNames(fake.sent[0]), '+11 +56 -56 -11');
});

test('a bad combination or media key is an error, nothing is sent', async () => {
  const fake = fakeSystem();
  const keyboard = createKeyboard({ system: fake.system });
  await assert.rejects(keyboard.combo('Control+'), { code: 'badCombo' });
  await assert.rejects(keyboard.media('louder'), { code: 'badMedia' });
  await assert.rejects(keyboard.text(''), { code: 'emptyText' });
  assert.equal(fake.sent.length, 0);
});

test('keys Windows refuses are reported', async () => {
  const fake = fakeSystem({ accepted: false });
  await assert.rejects(createKeyboard({ system: fake.system }).media('next'), { code: 'blocked' });
});

test('waits for the modifiers of a hotkey to be released', async () => {
  const fake = fakeSystem({ held: new Set([0x11]) });
  const sending = createKeyboard({ system: fake.system }).combo('F5');
  await wait(40);
  assert.equal(fake.sent.length, 0);
  fake.held.clear();
  await sending;
  assert.equal(fake.sent.length, 1);
});

test('gives the keyboard back to the window the deck opened over', async () => {
  const fake = fakeSystem();
  const keyboard = createKeyboard({ system: fake.system });
  keyboard.rememberTarget();
  await keyboard.restoreTarget();
  assert.deepEqual(fake.focused, ['game-window']);
});

test('pastes a text, presses Enter, then puts the clipboard back', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard();
  await createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 10 }).text('GG ! 🎉', { enter: true });
  assert.equal(clipboard.text, 'GG ! 🎉');
  assert.deepEqual(fake.sent.map(vkNames), ['+11 +56 -56 -11', '+d -d']);
  await wait(30);
  assert.equal(clipboard.text, 'copied before');
});

test('does not overwrite something copied meanwhile', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard();
  await createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 10 }).text('hello');
  clipboard.text = 'copied just now';
  await wait(30);
  assert.equal(clipboard.text, 'copied just now');
});

test('an empty clipboard is emptied again', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard('');
  await createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 10 }).text('hello');
  await wait(30);
  assert.equal(clipboard.writes.at(-1), 'cleared');
});

test('formatted text copied before comes back too', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard('bold', { 'text/html': '<b>bold</b>', 'electron application/osclipboard;format="Private"': 'x' });
  await createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 10 }).text('hello');
  await wait(30);
  assert.deepEqual(clipboard.extra, { 'text/plain': 'bold', 'text/html': '<b>bold</b>' });
});

test('an unreadable clipboard does not stop the paste', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard();
  clipboard.read = async () => {
    throw new Error('held by another app');
  };
  await createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 10 }).text('hello');
  assert.equal(fake.sent.length, 1);
});

test('tells when a mouse button is held down', () => {
  const fake = fakeSystem();
  const keyboard = createKeyboard({ system: fake.system });
  assert.equal(keyboard.mouseDown(), false);
  fake.held.add(0x02);
  assert.equal(keyboard.mouseDown(), true);
});

test('two pastes in a row still put back what was copied before', async () => {
  const fake = fakeSystem();
  const clipboard = fakeClipboard();
  const keyboard = createKeyboard({ system: fake.system, clipboard, ClipboardItem: FakeClipboardItem, restoreDelay: 20 });
  await keyboard.text('first');
  await keyboard.text('second');
  await wait(50);
  assert.equal(clipboard.text, 'copied before');
});

test('keys only partly accepted by Windows are reported', async () => {
  const fake = fakeSystem();
  const system = fake.system();
  system.send = (events) => events.length - 1;
  await assert.rejects(createKeyboard({ system: () => system }).combo('Control+V'), { code: 'blocked' });
});
