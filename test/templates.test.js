// Library of templates (src/shared/templates.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadBrowserScript, i18n, SRC } = require('./helpers');
const { parseCombo, MEDIA } = require('../src/keyboard');

const lib = loadBrowserScript('shared/templates.js', { structuredClone });
// Top-level constants of a browser script stay in its scope: read them from there.
const { TEMPLATES, TEMPLATE_CATEGORIES } = vm.runInContext('({ TEMPLATES, TEMPLATE_CATEGORIES })', lib);
// Plain objects of this realm, so deepEqual compares them by value.
const buildTemplate = (...args) => JSON.parse(JSON.stringify(lib.buildTemplate(...args)));
const ICONS = path.join(SRC, '..', 'node_modules', 'lucide-static', 'icons');
const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', 'en.json'), 'utf8'));

test('every template is valid: fits its grid, known category, ids unique', () => {
  assert.equal(new Set(TEMPLATES.map((tpl) => tpl.id)).size, TEMPLATES.length);
  for (const tpl of TEMPLATES) {
    assert.ok(TEMPLATE_CATEGORIES.includes(tpl.category), tpl.id);
    assert.ok(tpl.keys.length <= tpl.grid.cols * tpl.grid.rows, tpl.id);
    assert.ok(tpl.grid.cols <= 8 && tpl.grid.rows <= 6, tpl.id);
  }
});

test('every key of every template works and is translated', () => {
  for (const tpl of TEMPLATES) {
    for (const key of [`tpl.${tpl.id}.name`, `tpl.${tpl.id}.description`]) assert.ok(key in en, key);
    for (const key of tpl.keys) {
      assert.ok(key.label in en, key.label);
      assert.ok(fs.existsSync(path.join(ICONS, `${key.symbol}.svg`)), key.symbol);
      if (key.action.type === 'keys') assert.ok(parseCombo(key.action.keys), key.action.keys);
      if (key.action.type === 'media') assert.ok(key.action.key in MEDIA, key.action.key);
      if (key.action.type === 'text') assert.ok(key.action.text in en, key.action.text);
    }
  }
});

test('builds the keys in the current language', () => {
  const music = buildTemplate(TEMPLATES.find((tpl) => tpl.id === 'music'));
  assert.equal(music.name, 'Music and video');
  assert.equal(music.buttons[1].label, 'Play');
  assert.deepEqual(music.buttons[1].action, { type: 'media', key: 'playPause' });
  assert.match(music.buttons[0].color, /^#[0-9a-f]{6}$/);
  assert.equal(music.todo, 0);

  const chat = buildTemplate(TEMPLATES.find((tpl) => tpl.id === 'chat'));
  assert.equal(chat.buttons[0].action.text, 'Thanks for the follow! 💜');
  // The Discord link is the streamer's own.
  assert.equal(chat.todo, 1);
});

test('the stream template takes the scenes and microphone from OBS', () => {
  const stream = TEMPLATES.find((tpl) => tpl.id === 'stream');
  const filled = buildTemplate(stream, { scenes: ['Starting', 'Game', 'Pause', 'End', 'Extra'], inputs: ['Desktop Audio', 'Mic/Aux'] });
  assert.deepEqual(filled.buttons.slice(0, 4).map((b) => [b.label, b.action.scene]), [
    ['Starting', 'Starting'],
    ['Game', 'Game'],
    ['Pause', 'Pause'],
    ['End', 'End'],
  ]);
  assert.equal(filled.buttons[7].action.input, 'Mic/Aux');
  assert.equal(filled.todo, 0);

  // Not connected: placeholders, to complete.
  const empty = buildTemplate(stream);
  assert.equal(empty.buttons[0].label, 'Scene 1');
  assert.equal(empty.buttons[0].action.scene, '');
  assert.equal(empty.todo, 5);

  // Only two scenes: the other two keys stay to complete.
  assert.equal(buildTemplate(stream, { scenes: ['A', 'B'], inputs: ['Mic'] }).todo, 2);
});

test('building a template never changes the template itself', () => {
  const stream = TEMPLATES.find((tpl) => tpl.id === 'stream');
  buildTemplate(stream, { scenes: ['Game'] });
  assert.equal(stream.keys[0].action.scene, '');
});

test('names fit a page name in every language', () => {
  for (const code of Object.keys(i18n.LANGUAGES)) {
    i18n.setLanguage(code);
    for (const tpl of TEMPLATES) assert.ok(i18n.t(`tpl.${tpl.id}.name`).length <= 30, `${code} ${tpl.id}`);
  }
  i18n.setLanguage('en');
});
