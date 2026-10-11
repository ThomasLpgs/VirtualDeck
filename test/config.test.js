const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { normalize } = require('../src/config');

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

test('the renderer-only image URL is never saved', () => {
  const cfg = normalize({ buttons: [{ image: 'C:\\a.png', imageUrl: 'file:///C:/a.png' }] });
  assert.equal('imageUrl' in cfg.buttons[0], false);
});
