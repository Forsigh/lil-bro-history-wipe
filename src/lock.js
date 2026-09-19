// Lil Bro Wipe: History Cleaner
// The optional PIN lock, and the wording that goes with it. Pure crypto helpers so
// the pages stay thin and the rules can be tested under node (WebCrypto is there too).

export const MIN_PIN_LENGTH = 4;
export const PIN_ITERATIONS = 150000;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30000;
// There is no server, so there is no reset email. This word is the way out.
export const RECOVERY_WORD = 'lilbro';

export const LOCK_MESSAGES = {
  empty: 'Type a PIN first.',
  tooShort: `At least ${MIN_PIN_LENGTH} characters, so it is not a one-key guess.`,
  mismatch: 'The two PINs are not the same.',
  wrong: 'Wrong PIN.',
  wrongLeft: (left) => `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  lockedOut: (secs) => `Too many tries. Wait ${secs}s.`,
  saved: 'PIN saved. Your list stays hidden until you unlock it.',
  removed: 'PIN removed. Nothing is hidden any more.',
  open: 'Unlocked for now. Reloading this page hides the list again.',
  listHidden: 'Your list is hidden while the lock is on.',
  forgot: 'Forgot the PIN?',
  recoveryLead:
    'There is no internet connection here, so no reset link can be sent. Type lilbro instead: the PIN goes, and so does everything the extension has saved. Every site and word on your list, every switch, the log, the count. None of it comes back.',
  recoveryWrong: 'That is not the word.',
  recoveryDone: 'PIN removed, and everything saved is gone. The extension is back to square one.',
  honest:
    'This keeps the list off the screen when someone else opens these pages. It does not encrypt anything, and anyone who can reach your browser settings can still take the extension out.',
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
