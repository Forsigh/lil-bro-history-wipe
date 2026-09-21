// Lil Bro: confirmation gates for destructive actions.
// Pure logic, no DOM and no chrome.* usage, so the suite can prove the ordering:
// the final confirmation is unreachable unless the typed phrase matched first.
//
// The wording below is looked up per read (getters), because a table built at import
// time would be frozen before the locale is fetched: that is how English leaks into a
// Polish screen. The English literal stays as the fallback.
import { t } from './i18n.js';

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
  get wipeAllPhrase() {
    return t('gateWipeAllPhrase', [WIPE_ALL_PHRASE]) || `Step 1 of 2: type ${WIPE_ALL_PHRASE} below to arm it.`;
  },
  get wipeAllStep1() {
    return (
      t('gateWipeAllStep1', [WIPE_ALL_PHRASE]) ||
      'Step 1 of 2\n\n' +
        'All your history will be wiped: every entry, not just the ones that match your rules.\n\n' +
        'Cookies, cache, passwords and site data are not touched.\n\n' +
        `Type ${WIPE_ALL_PHRASE} to continue:`
    );
  },
  get wipeAllConfirm() {
    return (
      t('gateWipeAllConfirm') ||
      'Step 2 of 2\n\nAre you sure you want to continue?\n\n' +
        'The entire browsing history will be erased. This cannot be undone.'
    );
  },
  get wipeAllStep2() {
    return t('gateWipeAllStep2') || 'Confirm: erase ALL history';
  },
  get wipeAllArmed() {
    return t('gateWipeAllArmed') || 'Step 2 of 2: click the red button to erase everything.';
  },
  get wipeAllTimeout() {
    return t('gateWipeAllTimeout') || 'Confirmation timed out. Nothing was wiped, so start again.';
  },

  get wipeNowConfirm() {
    return (
      t('gateWipeNowConfirm') ||
      'Wipe the history entries that match your rules now?\n\n' +
        'This cannot be undone. Nothing outside your rules is touched, and cookies and cache are never touched.'
    );
  },

  get wipeAllArm() {
    return (
      t('gateWipeAllArm') ||
      'Wipe everything from now on?\n\n' +
        'Every trigger will erase the whole history instead of just your list. Arming this erases nothing by ' +
        'itself, and each wipe still asks twice.'
    );
  },
  get keepListConfirm() {
    return (
      t('gateKeepListConfirm') ||
      'Turn the keep list on?\n\n' +
        'Every site you have not listed gets erased from history, instead of only the sites you listed.\n\n' +
        'Cookies, cache, passwords and site data are not touched.'
    );
  },
  get keepListEmpty() {
    return t('gateKeepListEmpty') || 'Add at least one site to keep before switching this on.';
  },

  get armWipeNow() {
    return t('gateArmWipeNow') || 'Click again to wipe';
  },
  get wipeNowHint() {
    return t('gateWipeNowHint') || 'Click the button once more to wipe the entries that match your rules.';
  },
  get wipeNowTimeout() {
    return t('gateWipeNowTimeout') || 'Timed out - nothing was wiped. Click Wipe now to start again.';
  },

  get clearLogConfirm() {
    return (
      t('gateClearLogConfirm') || 'Clear the local log of wiped entries? History itself is not affected.'
    );
  },
  removeRule: (label) =>
    t('gateRemoveRule', [label]) ||
    `Remove the rule for ${label}?\n\nAlready-wiped entries stay wiped and nothing in your history changes.`,
  importConfirm: (n) =>
    t('gateImportConfirm', [n]) || `Add ${n} rule${n === 1 ? '' : 's'} from that file? Existing rules are kept.`,
};
