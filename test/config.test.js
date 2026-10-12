const test = require('node:test');
const assert = require('node:assert/strict');
const { electron } = require('./helpers');
const fs = require('fs');
const { normalize, save } = require('../src/config');

test('an empty config gets the defaults', () => {
  const cfg = normalize({});
  assert.equal(cfg.hotkey, 'Control+Shift+Space');
  assert.deepEqual(cfg.grid, { cols: 3, rows: 2 });
  assert.equal(cfg.buttons.length, 6);
  assert.equal(cfg.deckScale, 1);
  assert.equal(cfg.deckPosition, null);
  assert.equal(cfg.software, 'obs');
});

test('grid, deck size and software are kept within bounds', () => {
  const cfg = normalize({ grid: { cols: 99, rows: 0 }, deckScale: 9, software: 'xsplit' });
  assert.deepEqual(cfg.grid, { cols: 8, rows: 1 });
  assert.equal(cfg.deckScale, 1.6);
  assert.equal(cfg.software, 'obs');
  assert.equal(normalize({ deckScale: 0.1 }).deckScale, 0.6);
});

test('a deck position must be two numbers', () => {
  assert.deepEqual(normalize({ deckPosition: { x: 10.4, y: -20 } }).deckPosition, { x: 10, y: -20 });
  assert.equal(normalize({ deckPosition: { x: 'a', y: 3 } }).deckPosition, null);
});

test('buttons from a hand-edited or imported file are repaired', () => {
  const cfg = normalize({
    hotkey: 42,
    buttons: [null, { label: 5, color: {}, action: 'abc' }, { action: { type: 7 } }],
  });
  assert.equal(cfg.hotkey, 'Control+Shift+Space');
  assert.equal(cfg.buttons[0].action.type, 'none');
  assert.equal(cfg.buttons[1].label, '');
  assert.equal(typeof cfg.buttons[1].color, 'string');
  assert.deepEqual(cfg.buttons[1].action, { type: 'none' });
  assert.equal(cfg.buttons[2].action.type, 'none');
});

test('buttons beyond the grid are kept (shrinking the grid is not destructive)', () => {
  const buttons = Array.from({ length: 9 }, (_, i) => ({ label: `B${i}` }));
  const cfg = normalize({ grid: { cols: 2, rows: 2 }, buttons });
  assert.equal(cfg.buttons.length, 9);
  assert.equal(cfg.buttons[8].label, 'B8');
});

test('each key has its own hotkey, empty by default', () => {
  const cfg = normalize({ buttons: [{ hotkey: 'Control+Alt+1' }, { hotkey: 12 }, {}] });
  assert.deepEqual(
    cfg.buttons.slice(0, 3).map((b) => b.hotkey),
    ['Control+Alt+1', '', ''],
  );
});

test('multi-action steps are cleaned: bounded delay, no nested multi-action', () => {
  const cfg = normalize({
    buttons: [
      {
        action: {
          type: 'multi',
          steps: [
            { delay: 9999, action: { type: 'obs-scene', scene: 'A' } },
            { delay: 'x', action: { type: 'multi', steps: [] } },
            null,
            { action: 'nope' },
          ],
        },
      },
    ],
  });
  assert.deepEqual(cfg.buttons[0].action.steps, [{ delay: 600, action: { type: 'obs-scene', scene: 'A' } }]);
});

test('pages: each one starts at its own 48-key boundary, whatever the grid size', () => {
  const cfg = normalize({ grid: { cols: 3, rows: 2 }, pageCount: 3 });
  // Pages 1 and 2 are full (48 slots), page 3 has the 6 keys of the grid.
  assert.equal(cfg.buttons.length, 2 * 48 + 6);
  assert.equal(normalize({ pageCount: 99 }).pageCount, 10);
  assert.equal(normalize({}).pageCount, 1);
});

test('each page has its own grid; older configs give every page the main grid', () => {
  const old = normalize({ grid: { cols: 4, rows: 2 }, pageCount: 2 });
  assert.deepEqual(old.pageGrids, [{ cols: 4, rows: 2 }, { cols: 4, rows: 2 }]);

  const named = normalize({ pageCount: 3, pageNames: ['  Sons ', 42, 'x'.repeat(50), 'extra'] });
  assert.deepEqual(named.pageNames, ['Sons', '', 'x'.repeat(30)]);
  assert.deepEqual(normalize({}).pageNames, ['']);
  const cfg = normalize({ grid: { cols: 3, rows: 2 }, pageCount: 2, pageGrids: [{ cols: 5, rows: 1 }, { cols: 2, rows: 9 }] });
  assert.deepEqual(cfg.pageGrids, [{ cols: 5, rows: 1 }, { cols: 2, rows: 6 }]);
  // `grid` follows page 1, and the last page is padded to its own grid.
  assert.deepEqual(cfg.grid, { cols: 5, rows: 1 });
  assert.equal(cfg.buttons.length, 48 + 2 * 6);
});

test('the renderer-only image URL is never saved', () => {
  const cfg = normalize({ buttons: [{ image: 'C:\\a.png', imageUrl: 'file:///C:/a.png' }] });
  assert.equal('imageUrl' in cfg.buttons[0], false);
});

test('saving an unchanged config does not write the disk again', (t) => {
  // config.json goes to the test folder of the Electron stand-in (see helpers.js).
  t.after(() => fs.rmSync(electron.app.getPath('userData'), { recursive: true, force: true }));
  const write = t.mock.method(fs, 'writeFileSync');
  const cfg = save({ grid: { cols: 2, rows: 1 }, buttons: [{ id: 'a' }, { id: 'b' }] });
  save(cfg);
  save(structuredClone(cfg));
  assert.equal(write.mock.callCount(), 1);
  save({ ...cfg, hotkey: 'F13' });
  assert.equal(write.mock.callCount(), 2);
});

test('phone settings are off by default and keep only a valid key', () => {
  assert.deepEqual(normalize({}).remote, { enabled: false, port: 0, key: '', maxPhones: 1, devices: [] });
  const key = 'a'.repeat(43);
  assert.deepEqual(normalize({ remote: { enabled: true, port: 41234, key, maxPhones: 0 } }).remote, {
    enabled: true,
    port: 41234,
    key,
    maxPhones: 0,
    devices: [],
  });
  // Paired phones: valid ids only, no duplicates, never more than the limit.
  const ids = ['phone-one-0123456789', 'phone-two-0123456789'];
  assert.deepEqual(normalize({ remote: { maxPhones: 1, devices: [...ids, 'bad id', 42] } }).remote.devices, [ids[0]]);
  assert.deepEqual(normalize({ remote: { maxPhones: 3, devices: [ids[0], ids[0], ids[1]] } }).remote.devices, ids);
  assert.equal(normalize({ remote: { enabled: 'yes', key: 'bad key' } }).remote.enabled, false);
  assert.equal(normalize({ remote: { key: 'bad key' } }).remote.key, '');
  assert.equal(normalize({ remote: { port: 99999 } }).remote.port, 65535);
});

test('Hue bridge settings keep only well-formed values', () => {
  const empty = { ip: '', id: '', name: '', cert: '', key: '' };
  assert.deepEqual(normalize({}).hue, empty);
  const cert = Array.from({ length: 32 }, () => 'AB').join(':');
  const paired = { ip: '192.168.1.20', id: '001788fffe123456', name: 'Hue Bridge', cert, key: 'a'.repeat(40) };
  assert.deepEqual(normalize({ hue: paired }).hue, paired);
  assert.deepEqual(normalize({ hue: { ip: 'evil.example', id: 'x', name: 42, cert: 'AB', key: 'short' } }).hue, empty);
});
