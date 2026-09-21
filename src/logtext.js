// Lil Bro Wipe: History Cleaner
// The wording of a log row, in one place, because two pages show one: the settings
// page with the log itself, and the popup with what a sweep would take. Both need the
// same sentence for the same reason, and neither should invent its own.

/**
 * Why an entry was cleaned, said in the reader's language.
 * The worker writes a code (`word-url`, `site`, `keep-list`, ...) plus the word that
 * was involved, so the sentence can be built here where the language is known.
 * Entries from an older build carry only the rule string, which is shown as it is.
 */
export function whyLine(t, entry) {
  const word = entry && entry.word ? entry.word : '';
  const fallback = {
    'word-url': `word “${word}” in the address`,
    'word-title': `word “${word}” in the page title`,
    'pattern-url': `pattern “${word}” in the address`,
    'pattern-title': `pattern “${word}” in the page title`,
    site: `site “${word}”`,
    address: `address starts with “${word}”`,
    'keep-list': 'not on your keep list',
    'wipe-all': 'everything, on your order',
    extras: 'extra browsing data you asked to clear',
    cookies: 'cookies for this site, on tab close',
  };
  const keys = {
    'word-url': 'logWordInAddress',
    'word-title': 'logWordInTitle',
    'pattern-url': 'logPatternInAddress',
    'pattern-title': 'logPatternInTitle',
    site: 'logSite',
    address: 'logAddressStarts',
    'keep-list': 'logKeepList',
    'wipe-all': 'logWipeAll',
    extras: 'logExtras',
    cookies: 'logCookies',
  };
  const code = entry && entry.why;
  if (!code || !fallback[code]) return (entry && entry.rule) || '';
  return t(keys[code], [word]) || fallback[code];
}

/** The headline for a row: what the page called itself, or the site when it did not. */
export function headline(entry) {
  const title = shorten((entry && entry.title) || '', 96);
  return title || hostLabel((entry && entry.url) || '');
}

/** Enough of an address to recognise the site, without the token soup. */
export function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || shorten(url, 60);
  } catch {
    return shorten(url, 60);
  }
}

/** Cut to a length a row can hold, with an ellipsis when something was dropped. */
export function shorten(text, max) {
  const s = String(text == null ? '' : text).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
