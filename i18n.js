// Lil Bro: translations
//
// English is the source of truth and stays in the markup. A page calls setLang()
// and then applyI18n(), which swaps in the chosen language where a message exists
// and leaves the English in place where it does not, so a half-finished locale can
// never blank out a label.
//
// Chrome picks the language of an extension by the browser's own setting, so the
// bundles are read straight from the package instead: that is what lets the
// Language row in settings win over the browser.

let bundle = null;
const cache = new Map();

async function load(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let out = null;
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    out = res.ok ? await res.json() : null;
  } catch {
    out = null;
  }
  cache.set(lang, out);
  return out;
}

function browserLanguage() {
  try {
    return chrome.i18n.getUILanguage().split('-')[0];
  } catch {
    return 'en';
  }
}

/** The languages in the package, and which one the settings row is asking for. */
export async function languages() {
  const wanted = ['en', 'pl'];
  const known = [];
  for (const lang of wanted) {
    if (await load(lang)) known.push(lang);
  }
  return known;
}

/** 'auto' follows the browser. A language with no bundle falls back to English. */
export async function setLang(setting) {
  const want = !setting || setting === 'auto' ? browserLanguage() : setting;
  bundle = (await load(want)) || (await load('en')) || null;
  return want;
}

export function t(key, subs) {
  const msg = bundle && bundle[key] ? bundle[key].message : '';
  if (!msg) return '';
  if (!subs) return msg;
  const list = Array.isArray(subs) ? subs : [subs];
  return msg.replace(/\$(\d)/g, (_, n) => list[Number(n) - 1] ?? '');
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const msg = t(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const msg = t(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  }
}

/** The language the browser asks for, for a footer or a settings note. */
export function uiLanguage() {
  return browserLanguage();
}
