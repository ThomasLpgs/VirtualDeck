const fs = require('fs');
const path = require('path');

// Native names, shown as-is in the language picker whatever the current language.
const LANGUAGES = {
  fr: 'Français',
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
};
const FALLBACK = 'en';

let current = FALLBACK;
let strings = {};

function readLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', `${code}.json`), 'utf8'));
}

// setting: 'auto' or a language code. 'auto' follows the Windows display language.
function resolveLanguage(setting, systemLanguages = []) {
  if (LANGUAGES[setting]) return setting;
  for (const tag of systemLanguages) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (LANGUAGES[code]) return code;
  }
  return FALLBACK;
}

function setLanguage(code) {
  current = LANGUAGES[code] ? code : FALLBACK;
  // English fills any key a translation is missing.
  strings = { ...readLocale(FALLBACK), ...readLocale(current) };
  return current;
}

function t(key, vars = {}) {
  const text = strings[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Everything a renderer needs to translate itself.
function bundle() {
  return { lang: current, strings, languages: LANGUAGES };
}

setLanguage(FALLBACK);

module.exports = { LANGUAGES, resolveLanguage, setLanguage, t, bundle };
