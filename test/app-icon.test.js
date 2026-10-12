const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveAppIcon } = require('../src/app-icon');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdeck-icon-'));

// Stand-in for Electron's app / shell: a fixed small PNG as Windows' own icon.
const fakeElectron = (calls = []) => ({
  app: {
    getFileIcon: async (file) => {
      calls.push(file);
      return { isEmpty: () => false, toPNG: () => Buffer.concat([PNG_SIGNATURE, Buffer.from('fake')]) };
    },
  },
  shell: { readShortcutLink: () => ({}) },
});

test('no icon for links, relative paths or missing files', async () => {
  const dir = tempDir();
  for (const target of ['spotify:', 'https://example.com', 'notepad.exe', 'C:\\nope\\missing.exe', '', null]) {
    assert.equal(await saveAppIcon(target, dir, fakeElectron()), '', String(target));
  }
});

test("a document gets Windows' icon for its type", async () => {
  const dir = tempDir();
  const doc = path.join(dir, 'notes.txt');
  fs.writeFileSync(doc, 'hello');
  const calls = [];
  const out = await saveAppIcon(doc, path.join(dir, 'media'), fakeElectron(calls));
  assert.deepEqual(calls, [doc]);
  assert.ok(fs.readFileSync(out).subarray(0, 4).equals(PNG_SIGNATURE));
});

test('a program gives its large icon, cropped square around what is drawn', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const calls = [];
  const out = await saveAppIcon(path.join(process.env.WINDIR, 'System32', 'notepad.exe'), dir, fakeElectron(calls));
  assert.deepEqual(calls, [], 'the 32 px fallback was not needed');
  const png = fs.readFileSync(out);
  assert.ok(png.subarray(0, 4).equals(PNG_SIGNATURE));
  // PNG header: width and height, big-endian, at bytes 16 and 20. Square, from the 256 px icon
  // minus its transparent margins.
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(width, height);
  assert.ok(width > 128 && width <= 256, `size ${width}`);
});
