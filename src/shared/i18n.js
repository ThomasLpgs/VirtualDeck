/* eslint-disable no-unused-vars -- used by deck.js and editor.js */

// Renderer-side translations. The strings come from the main process (src/i18n.js).
let I18N = { lang: 'en', strings: {}, languages: {} };

function t(key, vars = {}) {
  const text = I18N.strings[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Translates static markup:
//   data-i18n="key"            -> textContent
//   data-i18n-html="key"       -> innerHTML (only for our own locale files, which may contain <strong>…)
//   data-i18n-placeholder / data-i18n-title / data-i18n-aria-label -> the matching attribute
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  root.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)));
  document.documentElement.lang = I18N.lang;
}

async function loadI18n() {
  I18N = await window.api.getI18n();
  applyI18n();
  document.body.classList.remove('i18n-pending');
}
