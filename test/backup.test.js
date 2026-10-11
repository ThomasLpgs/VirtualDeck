const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./helpers');
const backup = require('../src/backup');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtualdeck-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('export then import restores buttons and their media', (t) => {
  const dir = tempDir(t);
  const image = path.join(dir, 'logo.png');
  const sound = path.join(dir, 'horn.mp3');
  fs.writeFileSync(image, 'PNG');
  fs.writeFileSync(sound, 'MP3');
  const cfg = {
    hotkey: 'Control+Shift+Space',
    closeAfterAction: true,
    grid: { cols: 2, rows: 1 },
    obs: { url: 'ws://127.0.0.1:4455', password: 'secret' },
    buttons: [
      { label: 'Logo', image, action: { type: 'none' } },
      { label: 'Horn', image: '', action: { type: 'sound', file: sound, volume: 1 } },
    ],
  };

  const { bundle, missing } = backup.exportBundle(cfg);
  assert.deepEqual(missing, []);
  // Connection settings (and their secrets) are never exported.
  assert.equal(JSON.stringify(bundle).includes('secret'), false);

  const restored = backup.restoreBundle(backup.parseBundle(JSON.stringify(bundle)), path.join(dir, 'media'));
  assert.equal(fs.readFileSync(restored.buttons[0].image, 'utf8'), 'PNG');
  assert.equal(fs.readFileSync(restored.buttons[1].action.file, 'utf8'), 'MP3');
  assert.equal(restored.buttons[1].label, 'Horn');
});

test('missing media files are reported, not fatal', () => {
  const { missing } = backup.exportBundle({
    grid: { cols: 1, rows: 1 },
    buttons: [{ image: 'C:\\does-not-exist.png', action: { type: 'none' } }],
  });
  assert.deepEqual(missing, ['C:\\does-not-exist.png']);
});

test('an imported file cannot point at network shares or local files', (t) => {
  const bundle = {
    format: 'virtualdeck/backup',
    version: 1,
    config: {
      buttons: [
        { image: '\\\\attacker\\share\\x.png', action: { type: 'sound', file: 'C:\\Windows\\win.ini' } },
      ],
    },
    media: {},
  };
  const restored = backup.restoreBundle(bundle, tempDir(t));
  assert.equal(restored.buttons[0].image, '');
  assert.equal(restored.buttons[0].action.file, '');
});

test('embedded media names cannot escape the media folder', (t) => {
  const dir = tempDir(t);
  const id = 'a'.repeat(16);
  const bundle = {
    format: 'virtualdeck/backup',
    version: 1,
    config: { buttons: [{ image: `media:${id}`, action: { type: 'none' } }] },
    media: { [id]: { name: '..\\..\\evil:stream.exe', data: Buffer.from('x').toString('base64') } },
  };
  const restored = backup.restoreBundle(bundle, dir);
  assert.equal(path.dirname(restored.buttons[0].image), dir);
  assert.doesNotMatch(path.basename(restored.buttons[0].image), /[\\/:]/);
});

test('invalid or newer backups are refused', () => {
  assert.throws(() => backup.parseBundle('not json'));
  assert.throws(() => backup.parseBundle(JSON.stringify({ format: 'other', config: { buttons: [] } })));
  assert.throws(() =>
    backup.parseBundle(JSON.stringify({ format: 'virtualdeck/backup', version: 99, config: { buttons: [] } })),
  );
});
