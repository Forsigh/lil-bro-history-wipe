// Lil Bro: translations
//
// English is the source of truth and stays in the markup. A page calls
// applyI18n() on load, which swaps in the browser's language where a message
// exists and leaves the English in place where it does not, so a half-finished
// locale can never blank out a label.

export function t(key, subs) {
  try {
    return chrome.i18n.getMessage(key, subs) || '';
  } catch {
    return '';
  }
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

/** The language Chrome will use for this UI, for a footer or a settings note. */
export function uiLanguage() {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}
