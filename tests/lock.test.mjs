// Tests for the PIN lock: node tests/lock.test.mjs
import assert from 'node:assert/strict';
import {
  makePinRecord,
  verifyPin,
  isLockConfigured,
  pinProblem,
  attemptState,
  checkRecovery,
  LOCK_MESSAGES,
  MIN_PIN_LENGTH,
  PIN_ITERATIONS,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
  RECOVERY_WORD,
} from '../lock.js';
import { DEFAULT_SETTINGS } from '../store.js';

let pass = 0;
let fail = 0;

function check(label, fn) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    fail++;
    console.log(`  FAIL ${label}: check() got an async callback, use checkAsync().`);
    return;
  }
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label}\n    ${e.message.split('\n')[0]}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label}\n    ${e.message.split('\n')[0]}`);
  }
}

const FAST = 1000; // a real PIN uses PIN_ITERATIONS; the tests only need the shape
const withLock = (extra) => ({ ...DEFAULT_SETTINGS, lockEnabled: true, ...extra });

console.log('defaults');
check('the lock is off by default', () => assert.equal(DEFAULT_SETTINGS.lockEnabled, false));
check('a fresh install has no hash', () => assert.equal(DEFAULT_SETTINGS.lockHash, ''));
check('a fresh install is unlocked', () => assert.equal(isLockConfigured(DEFAULT_SETTINGS), false));
check('the stored iteration count is a real one', () => assert.ok(PIN_ITERATIONS >= 100000));
check('the attempt limit is small and finite', () => assert.ok(MAX_ATTEMPTS <= 10 && MAX_ATTEMPTS > 0));
check('the cooldown is a few seconds, not forever', () => assert.ok(LOCKOUT_MS >= 5000 && LOCKOUT_MS <= 300000));

console.log('what the user types');
check('a good PIN passes', () => assert.equal(pinProblem('2468'), ''));
check('an empty PIN is refused', () => assert.equal(pinProblem(''), LOCK_MESSAGES.empty));
check('undefined is refused', () => assert.equal(pinProblem(undefined), LOCK_MESSAGES.empty));
check(`short PINs are refused (min ${MIN_PIN_LENGTH})`, () =>
  assert.equal(pinProblem('123'), LOCK_MESSAGES.tooShort));
check('exactly the minimum is allowed', () => assert.equal(pinProblem('1234'), ''));
check('a mismatched repeat is caught', () =>
  assert.equal(pinProblem('2468', '2469'), LOCK_MESSAGES.mismatch));
check('a matching repeat passes', () => assert.equal(pinProblem('2468', '2468'), ''));

console.log('what gets stored');
await checkAsync('the PIN itself is never stored', async () => {
  const rec = await makePinRecord('correct horse battery', FAST);
  assert.ok(!JSON.stringify(rec).includes('correct horse battery'));
  assert.deepEqual(Object.keys(rec).sort(), ['lockHash', 'lockIterations', 'lockSalt']);
});
await checkAsync('the hash is 256 bits of hex', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.match(rec.lockHash, /^[0-9a-f]{64}$/);
});
await checkAsync('the salt is 128 bits of hex', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.match(rec.lockSalt, /^[0-9a-f]{32}$/);
});
await checkAsync('the same PIN gets a different salt every time', async () => {
  const a = await makePinRecord('2468', FAST);
  const b = await makePinRecord('2468', FAST);
  assert.notEqual(a.lockSalt, b.lockSalt);
  assert.notEqual(a.lockHash, b.lockHash);
});
await checkAsync('the iteration count is remembered', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.equal(rec.lockIterations, FAST);
});

console.log('unlocking');
await checkAsync('the right PIN unlocks', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.equal(await verifyPin('2468', withLock(rec)), true);
});
await checkAsync('a wrong PIN does not', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.equal(await verifyPin('2469', withLock(rec)), false);
  assert.equal(await verifyPin('', withLock(rec)), false);
  assert.equal(await verifyPin('24680', withLock(rec)), false);
});
await checkAsync('case and spaces are not trimmed away', async () => {
  const rec = await makePinRecord('Open Sesame', FAST);
  assert.equal(await verifyPin('Open Sesame', withLock(rec)), true);
  assert.equal(await verifyPin('open sesame', withLock(rec)), false);
  assert.equal(await verifyPin(' Open Sesame', withLock(rec)), false);
});
await checkAsync('a hash with no salt is not a lock', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.equal(isLockConfigured(withLock({ ...rec, lockSalt: '' })), false);
  assert.equal(await verifyPin('2468', withLock({ ...rec, lockSalt: '' })), false);
});
await checkAsync('the lock being switched off beats a stored hash', async () => {
  const rec = await makePinRecord('2468', FAST);
  const off = { ...DEFAULT_SETTINGS, ...rec };
  assert.equal(isLockConfigured(off), false);
  assert.equal(await verifyPin('2468', off), false);
});
await checkAsync('a mangled hash length fails closed', async () => {
  const rec = await makePinRecord('2468', FAST);
  assert.equal(await verifyPin('2468', withLock({ ...rec, lockHash: 'ab' })), false);
});
await checkAsync('an import that lost the iterations still verifies', async () => {
  const rec = await makePinRecord('2468', PIN_ITERATIONS);
  assert.equal(await verifyPin('2468', withLock({ ...rec, lockIterations: 0 })), true);
});

console.log('throttle');
const NOW = 1_700_000_000_000;
check('one bad try leaves the rest', () => {
  const s = attemptState(1, NOW, NOW);
  assert.deepEqual([s.blocked, s.failsLeft], [false, MAX_ATTEMPTS - 1]);
});
check('four bad tries leave one', () => assert.equal(attemptState(4, NOW, NOW).failsLeft, 1));
check('the limit blocks', () => assert.equal(attemptState(MAX_ATTEMPTS, NOW, NOW).blocked, true));
check('the cooldown counts down', () =>
  assert.equal(attemptState(MAX_ATTEMPTS, NOW, NOW + LOCKOUT_MS / 2).waitMs, LOCKOUT_MS / 2));
check('the cooldown expires', () => {
  const s = attemptState(MAX_ATTEMPTS, NOW, NOW + LOCKOUT_MS + 1);
  assert.deepEqual([s.blocked, s.waitMs], [false, 0]);
});

console.log('the way out when the PIN is forgotten');
check('the recovery word is lilbro', () => assert.equal(RECOVERY_WORD, 'lilbro'));
check('the word works', () => assert.equal(checkRecovery('lilbro'), true));
check('case does not matter', () => assert.equal(checkRecovery('LilBro'), true));
check('stray spaces do not matter', () => assert.equal(checkRecovery('  lilbro '), true));
check('nothing near it works', () =>
  assert.deepEqual(
    [checkRecovery('lil bro'), checkRecovery('lilbroo'), checkRecovery('bro'), checkRecovery(''), checkRecovery(undefined)],
    [false, false, false, false, false]
  ));
check('the warning names the word', () => assert.ok(LOCK_MESSAGES.recoveryLead.includes(RECOVERY_WORD)));
check('the warning says what else is lost', () =>
  assert.ok(/(site|word on your list|switch|log)/.test(LOCK_MESSAGES.recoveryLead)));
check('the warning says it cannot be undone', () =>
  assert.ok(LOCK_MESSAGES.recoveryLead.includes('None of it comes back')));

console.log(`\nlock: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
