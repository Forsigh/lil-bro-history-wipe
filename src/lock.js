// Lil Bro Wipe: History Cleaner
// The optional PIN lock, and the wording that goes with it. Pure crypto helpers so
// the pages stay thin and the rules can be tested under node (WebCrypto is there too).

import { t } from './i18n.js';

export const MIN_PIN_LENGTH = 4;
export const PIN_ITERATIONS = 150000;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30000;
// There is no server, so there is no reset email. This word is the way out.
export const RECOVERY_WORD = 'lilbro';

/**
 * The wording that goes with the PIN, in the language the pages are showing.
 *
 * These are getters, not plain values: a table built once at import time would be
 * frozen before the locale is even fetched, which is how English ends up on a Polish
 * screen. Each read looks the message up again, and the English literal stays as the
 * fallback for a locale that has not been translated yet.
 */
export const LOCK_MESSAGES = {
  get empty() {
    return t('lockEmpty') || 'Type a PIN first.';
  },
  get tooShort() {
    return t('lockTooShort', [MIN_PIN_LENGTH]) || `At least ${MIN_PIN_LENGTH} characters, so it is not a one-key guess.`;
  },
  get mismatch() {
    return t('lockMismatch') || 'The two PINs are not the same.';
  },
  get wrong() {
    return t('lockWrong') || 'Wrong PIN.';
  },
  wrongLeft: (left) =>
    (left === 1 ? t('lockWrongLeftOne', [left]) : t('lockWrongLeftMany', [left])) ||
    `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  lockedOut: (secs) => t('lockLockedOut', [secs]) || `Too many tries. Wait ${secs}s.`,
  get saved() {
    return t('lockSaved') || 'PIN saved. Your list stays hidden until you unlock it.';
  },
  get removed() {
    return t('lockRemoved') || 'PIN removed. Nothing is hidden any more.';
  },
  get open() {
    return t('lockOpen') || 'Unlocked for now. Reloading this page hides the list again.';
  },
  get listHidden() {
    return t('lockListHidden') || 'Your list is hidden while the lock is on.';
  },
  get forgot() {
    return t('lockForgot') || 'Forgot the PIN?';
  },
  get recoveryLead() {
    return (
      t('lockRecoveryLead') ||
      'There is no internet connection here, so no reset link can be sent. Type lilbro instead: the PIN goes, and so does everything the extension has saved. Every site and word on your list, every switch, the log, the count. None of it comes back.'
    );
  },
  get recoveryWrong() {
    return t('lockRecoveryWrong') || 'That is not the word.';
  },
  get recoveryDone() {
    return t('lockRecoveryDone') || 'PIN removed, and everything saved is gone. The extension is back to square one.';
  },
  get honest() {
    return (
      t('lockHonest') ||
      'This keeps the list off the screen when someone else opens these pages. It does not encrypt anything, and anyone who can reach your browser settings can still take the extension out.'
    );
  },
};

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(pin, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

/**
 * What gets stored for a PIN: a random salt and a slow hash. The PIN itself is
 * never written anywhere, so nothing on disk is worth reading.
 */
export async function makePinRecord(pin, iterations = PIN_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const lockSalt = toHex(salt);
  return { lockHash: await derive(pin, lockSalt, iterations), lockSalt, lockIterations: iterations };
}

export function isLockConfigured(settings) {
  return !!(settings && settings.lockEnabled && settings.lockHash && settings.lockSalt);
}

export async function verifyPin(pin, settings) {
  if (!isLockConfigured(settings)) return false;
  if (typeof pin !== 'string' || !pin) return false;
  const iterations = Number(settings.lockIterations) || PIN_ITERATIONS;
  return timingSafeEqual(await derive(pin, settings.lockSalt, iterations), settings.lockHash);
}

/** '' when the PIN is usable. Pass repeat to check the second box too. */
export function pinProblem(pin, repeat) {
  const value = String(pin == null ? '' : pin);
  if (!value) return LOCK_MESSAGES.empty;
  if (value.length < MIN_PIN_LENGTH) return LOCK_MESSAGES.tooShort;
  if (repeat !== undefined && value !== String(repeat == null ? '' : repeat)) return LOCK_MESSAGES.mismatch;
  return '';
}

/** The way in when the PIN is gone. Case and stray spaces do not matter. */
export function checkRecovery(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === RECOVERY_WORD;
}

/**
 * Failed tries to a cooldown. Pure, so the throttle is tested without waiting:
 * after MAX_ATTEMPTS wrong PINs the pad refuses for LOCKOUT_MS.
 */
export function attemptState(fails, lastFailAt, now, maxAttempts = MAX_ATTEMPTS, lockoutMs = LOCKOUT_MS) {
  const count = Number(fails) || 0;
  const left = maxAttempts - count;
  if (count < maxAttempts) return { blocked: false, waitMs: 0, failsLeft: Math.max(0, left) };
  const waitMs = Math.max(0, lockoutMs - (Number(now) - (Number(lastFailAt) || 0)));
  return { blocked: waitMs > 0, waitMs, failsLeft: 0 };
}
