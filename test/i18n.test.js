const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SRC } = require('./helpers');
const { LANGUAGES, resolveLanguage } = require('../src/i18n');

const readLocale = (code) => JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', `${code}.json`), 'utf8'));
const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort();
// The app name is the same everywhere: only English defines it.
const ENGLISH_ONLY = ['app.name'];

const en = readLocale('en');
for (const code of Object.keys(LANGUAGES).filter((c) => c !== 'en')) {
  test(`${LANGUAGES[code]} has every text, with the same placeholders`, () => {
    const locale = readLocale(code);
    const missing = Object.keys(en).filter((key) => !(key in locale) && !ENGLISH_ONLY.includes(key));
    const unknown = Object.keys(locale).filter((key) => !(key in en));
    const mismatched = Object.keys(locale).filter(
      (key) => key in en && placeholders(en[key]).join() !== placeholders(locale[key]).join(),
    );
    assert.deepEqual({ missing, unknown, mismatched }, { missing: [], unknown: [], mismatched: [] });
  });
}

test('"auto" follows the Windows language, falling back to English', () => {
  assert.equal(resolveLanguage('auto', ['fr-FR', 'en-US']), 'fr');
  assert.equal(resolveLanguage('auto', ['ja-JP']), 'en');
  assert.equal(resolveLanguage('de', ['fr-FR']), 'de');
});
