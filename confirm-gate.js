// Lil Bro: confirmation gates for destructive actions.
// Pure logic, no DOM and no chrome.* usage, so the suite can prove the ordering:
// the final confirmation is unreachable unless the typed phrase matched first.

export const WIPE_ALL_PHRASE = 'WIPE ALL';
export const ARM_WINDOW_MS = 5000;

export function normalizePhrase(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function checkPhrase(input, phrase = WIPE_ALL_PHRASE) {
  return normalizePhrase(input) === normalizePhrase(phrase);
}

/** Second click of a two-click confirmation must land inside the arm window. */
export function secondClickWithin(firstAt, now, windowMs = ARM_WINDOW_MS) {
  if (firstAt === null || firstAt === undefined) return false;
  const delta = now - firstAt;
  return delta >= 0 && delta <= windowMs;
}

/**
 * Step 1: the user must type the phrase (askPhrase returns the typed string, or
 * null when cancelled).
 * Step 2: a final confirmation (finalConfirm returns true/false).
 *
 * Both are injected so the ordering can be tested without a browser.
 */
export async function doubleConfirm({ askPhrase, finalConfirm, phrase = WIPE_ALL_PHRASE } = {}) {
  if (typeof askPhrase !== 'function' || typeof finalConfirm !== 'function') {
    throw new Error('doubleConfirm needs askPhrase and finalConfirm');
  }

  const typed = await askPhrase();
  if (typed === null || typed === undefined) return { ok: false, reason: 'cancelled', step: 1 };
  if (!checkPhrase(typed, phrase)) return { ok: false, reason: 'phrase-mismatch', step: 1 };

  const yes = await finalConfirm();
  if (!yes) return { ok: false, reason: 'cancelled', step: 2 };

  return { ok: true, step: 2 };
}

/** Single-gate confirmation for destructive-but-bounded actions. */
export async function singleConfirm(ask) {
  if (typeof ask !== 'function') throw new Error('singleConfirm needs a callback');
  const yes = await ask();
  return yes === true ? { ok: true } : { ok: false, reason: 'cancelled' };
}

/** One place for the wording, so both surfaces warn in identical terms. */
export const MESSAGES = {
  wipeAllPhrase: `Step 1 of 2: type ${WIPE_ALL_PHRASE} below to arm it.`,
  wipeAllStep1:
    'Step 1 of 2\n\n' +
    'All your history will be wiped: every entry, not just the ones that match your rules.\n\n' +
    'Cookies, cache, passwords and site data are not touched.\n\n' +
    `Type ${WIPE_ALL_PHRASE} to continue:`,
  wipeAllConfirm:
    'Step 2 of 2\n\nAre you sure you want to continue?\n\n' +
    'The entire browsing history will be erased. This cannot be undone.',
  wipeAllStep2: 'Confirm: erase ALL history',
  wipeAllArmed: 'Step 2 of 2: click the red button to erase everything.',
  wipeAllTimeout: 'Confirmation timed out. Nothing was wiped, so start again.',

  wipeNowConfirm:
    'Wipe the history entries that match your rules now?\n\n' +
    'This cannot be undone. Nothing outside your rules is touched, and cookies and cache are never touched.',

  keepListConfirm:
    'Turn the keep list on?\n\n' +
    'Every site you have not listed gets erased from history, instead of only the sites you listed.\n\n' +
    'Cookies, cache, passwords and site data are not touched.',
  keepListEmpty: 'Add at least one site to keep before switching this on.',

  armWipeNow: 'Click again to wipe',
  wipeNowHint: 'Click the button once more to wipe the entries that match your rules.',
  wipeNowTimeout: 'Timed out - nothing was wiped. Click Wipe now to start again.',

  clearLogConfirm: 'Clear the local log of wiped entries? History itself is not affected.',
  removeRule: (label) => `Remove the rule for ${label}?\n\nAlready-wiped entries stay wiped and nothing in your history changes.`,
  importConfirm: (n) => `Add ${n} rule${n === 1 ? '' : 's'} from that file? Existing rules are kept.`,
};
