// Keyboard keys: media keys (play / pause, volume…), key combinations ("Ctrl+Shift+M") and
// ready-made text, sent to Windows as if typed (user32 SendInput, called through koffi).
// koffi is only loaded the first time a key needs it: nothing runs in the background.

const MAX_TEXT = 2000;
// How long a held modifier (from a key's own hotkey) may delay the keys sent.
const MODIFIERS_WAIT_MS = 1000;
// The app pasted into reads the clipboard after Ctrl+V: the previous content comes back after that.
const CLIPBOARD_RESTORE_MS = 500;
const CLIPBOARD_TYPES = ['text/plain', 'text/html', 'text/rtf', 'image/png'];
// Left for the focus to come back to the window the deck was opened over.
const FOCUS_SETTLE_MS = 60;

const MODIFIERS = { Control: 0x11, Alt: 0x12, Shift: 0x10, Super: 0x5b };
// Order modifiers are pressed in (and shown in): Ctrl, Alt, Shift, Win.
const MODIFIER_ORDER = Object.keys(MODIFIERS);
const RIGHT_WIN = 0x5c;

// Keys a combination can end with, by their Electron accelerator name (what the editor records).
const KEYS = {
  Space: 0x20,
  Enter: 0x0d,
  Tab: 0x09,
  Escape: 0x1b,
  Backspace: 0x08,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  Pause: 0x13,
  Scrolllock: 0x91,
  PrintScreen: 0x2c,
};
for (let i = 0; i < 26; i++) KEYS[String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i <= 9; i++) {
  KEYS[String(i)] = 0x30 + i;
  KEYS[`num${i}`] = 0x60 + i;
}
for (let i = 1; i <= 24; i++) KEYS[`F${i}`] = 0x6f + i;

const MEDIA = {
  playPause: 0xb3,
  next: 0xb0,
  prev: 0xb1,
  stop: 0xb2,
  volumeUp: 0xaf,
  volumeDown: 0xae,
  volumeMute: 0xad,
};
// Each volume press moves the Windows volume by 2 %.
const MAX_MEDIA_REPEAT = 25;

// Keys Windows wants flagged as "extended" (else some apps see the numpad variant).
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, RIGHT_WIN, ...Object.values(MEDIA)]);

const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;

// "Control+Shift+M" -> { modifiers: [0x11, 0x10], key: 0x4d }, or null when it isn't a combination
// this module can send. A lone modifier isn't one.
function parseCombo(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator) return null;
  const parts = accelerator.split('+');
  const keyName = parts.pop();
  if (!Object.hasOwn(KEYS, keyName) || new Set(parts).size !== parts.length) return null;
  if (!parts.every((part) => Object.hasOwn(MODIFIERS, part))) return null;
  const modifiers = MODIFIER_ORDER.filter((name) => parts.includes(name)).map((name) => MODIFIERS[name]);
  return { modifiers, key: KEYS[keyName] };
}

// Key events of a combination: modifiers down, key down and up, modifiers up (in reverse).
function comboEvents({ modifiers, key }) {
  const down = (vk) => ({ vk, up: false });
  const up = (vk) => ({ vk, up: true });
  return [...modifiers.map(down), down(key), up(key), ...[...modifiers].reverse().map(up)];
}

function mediaEvents(name, times = 1) {
  if (!Object.hasOwn(MEDIA, name)) return null;
  const vk = MEDIA[name];
  const count = Math.min(MAX_MEDIA_REPEAT, Math.max(1, Math.round(Number(times)) || 1));
  return Array.from({ length: count }, () => [{ vk, up: false }, { vk, up: true }]).flat();
}

// The Windows calls, through koffi. Loaded once, on first use.
let win32 = null;
function loadWin32() {
  if (win32) return win32;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const KEYBDINPUT = koffi.struct('VD_KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  });
  // Only here so the union (and so INPUT) has the size Windows expects.
  const MOUSEINPUT = koffi.struct('VD_MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  });
  const INPUT = koffi.struct('VD_INPUT', { type: 'uint32', u: koffi.union('VD_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
  const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);
  const MapVirtualKeyW = user32.func('__stdcall', 'MapVirtualKeyW', 'uint32', ['uint32', 'uint32']);
  const GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int32']);
  const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', []);
  const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *']);
  const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['void *']);
  win32 = {
    send(events) {
      const inputs = events.map(({ vk, up }) => ({
        type: 1, // INPUT_KEYBOARD
        u: {
          ki: {
            wVk: vk,
            wScan: MapVirtualKeyW(vk, 0) & 0xffff,
            dwFlags: (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0),
            time: 0,
            dwExtraInfo: 0,
          },
        },
      }));
      return SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
    },
    isDown: (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0,
    foreground: () => GetForegroundWindow(),
    focus: (handle) => Boolean(handle) && IsWindow(handle) && SetForegroundWindow(handle),
  };
  return win32;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class KeyboardError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// system: the Windows calls (loadWin32 by default, a fake in the tests).
// clipboard, ClipboardItem: Electron's, for pasted text.
function createKeyboard({ system = loadWin32, clipboard, ClipboardItem, restoreDelay = CLIPBOARD_RESTORE_MS } = {}) {
  // Window the deck was opened over: keys pressed in the deck go back to it.
  let target = null;

  // What the clipboard holds (text, formatted text, image), to put it back after a paste.
  // Other formats some apps add (their own private data) are not kept.
  const saveClipboard = async () => {
    const saved = [];
    try {
      for (const item of await clipboard.read()) {
        const data = {};
        for (const type of item.types.filter((type) => CLIPBOARD_TYPES.includes(type))) {
          data[type] = await item.getType(type);
        }
        if (Object.keys(data).length) saved.push(data);
      }
    } catch {
      // Unreadable clipboard (held by another app): the text is pasted all the same.
    }
    return saved;
  };

  const send = (events) => {
    if (!system().send(events)) throw new KeyboardError('blocked');
  };

  // A key's own hotkey (Ctrl+Shift+F1…) is often still held when it runs: those modifiers would
  // join the keys sent. Wait a moment for the user to let go of them.
  async function modifiersReleased() {
    const deadline = Date.now() + MODIFIERS_WAIT_MS;
    const held = () => [...Object.values(MODIFIERS), RIGHT_WIN].some((vk) => system().isDown(vk));
    while (held() && Date.now() < deadline) await wait(15);
  }

  return {
    // Called just before the deck shows.
    rememberTarget() {
      try {
        target = system().foreground();
      } catch {
        target = null;
      }
    },
    // After the deck hid: gives the keyboard back to the window it was opened over.
    async restoreTarget() {
      try {
        system().focus(target);
      } catch {
        // The keys then go to whichever window Windows activated.
      }
      await wait(FOCUS_SETTLE_MS);
    },

    async combo(accelerator) {
      const combo = parseCombo(accelerator);
      if (!combo) throw new KeyboardError('badCombo');
      await modifiersReleased();
      send(comboEvents(combo));
    },

    async media(name, times) {
      const events = mediaEvents(name, times);
      if (!events) throw new KeyboardError('badMedia');
      await modifiersReleased();
      send(events);
    },

    // Pastes the text (clipboard + Ctrl+V: works with every keyboard layout and emojis), then puts
    // back what the clipboard held, unless something else was copied meanwhile.
    async text(text, { enter = false } = {}) {
      if (typeof text !== 'string' || !text) throw new KeyboardError('emptyText');
      const value = text.slice(0, MAX_TEXT);
      await modifiersReleased();
      const saved = await saveClipboard();
      await clipboard.writeText(value);
      try {
        send(comboEvents(parseCombo('Control+V')));
        if (enter) {
          // The paste lands first, then Enter sends it (a chat message).
          await wait(80);
          send(comboEvents(parseCombo('Enter')));
        }
      } finally {
        setTimeout(async () => {
          try {
            if ((await clipboard.readText()) !== value) return;
            if (saved.length) await clipboard.write(saved.map((data) => new ClipboardItem(data)));
            else clipboard.clear();
          } catch {
            // The pasted text stays in the clipboard: nothing else is lost.
          }
        }, restoreDelay);
      }
    },
  };
}

module.exports = { createKeyboard, parseCombo, comboEvents, mediaEvents, KeyboardError, MEDIA, KEYS, MAX_TEXT };
