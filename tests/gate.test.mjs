// Tests for the confirmation gates: node tests/gate.test.mjs
import assert from 'node:assert/strict';
import {
  checkPhrase,
  normalizePhrase,
  secondClickWithin,
  doubleConfirm,
  singleConfirm,
  MESSAGES,
  WIPE_ALL_PHRASE,
  ARM_WINDOW_MS,
} from '../confirm-gate.js';

let pass = 0;
let fail = 0;

function check(label, fn) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    fail++;
    console.log(`  FAIL ${label}: check() was given an async callback — its assertions would be swallowed. Use checkAsync().`);
    return;
  }
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label}: ${e.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label}: ${e.message}`);
  }
}

console.log('phrase matching');
check('exact phrase accepted', () => assert.equal(checkPhrase('WIPE ALL'), true));
check('lower case accepted', () => assert.equal(checkPhrase('wipe all'), true));
check('mixed case + padding accepted', () => assert.equal(checkPhrase('  Wipe   All  '), true));
check('empty rejected', () => assert.equal(checkPhrase(''), false));
check('partial phrase rejected', () => assert.equal(checkPhrase('WIPE'), false));
check('extra words rejected', () => assert.equal(checkPhrase('WIPE ALL NOW'), false));
check('random text rejected', () => assert.equal(checkPhrase('yes'), false));
check('null/undefined rejected', () => {
  assert.equal(checkPhrase(null), false);
  assert.equal(checkPhrase(undefined), false);
});
check('normalize collapses whitespace', () =>
  assert.equal(normalizePhrase('  a\t b   c '), 'A B C'));

console.log('two-click window');
check('second click inside the window', () => assert.equal(secondClickWithin(1000, 3000, 5000), true));
check('second click at the boundary', () => assert.equal(secondClickWithin(1000, 6000, 5000), true));
check('second click after the window', () => assert.equal(secondClickWithin(1000, 6001, 5000), false));
check('no first click', () => assert.equal(secondClickWithin(null, 3000), false));
check('clock going backwards is not a confirmation', () =>
  assert.equal(secondClickWithin(2000, 1000), false));

console.log('double confirmation ordering');
{
  const calls = [];
  const cancelFirst = await doubleConfirm({
    askPhrase: async () => {
      calls.push('askPhrase');
      return null;
    },
    finalConfirm: async () => {
      calls.push('finalConfirm');
      return true;
    },
  });
  check('cancelling step 1 stops the flow', () =>
    assert.deepEqual([cancelFirst.ok, cancelFirst.reason, calls], [false, 'cancelled', ['askPhrase']]));
}

{
  const calls = [];
  const wrongPhrase = await doubleConfirm({
    askPhrase: async () => {
      calls.push('askPhrase');
      return 'wipe';
    },
    finalConfirm: async () => {
      calls.push('finalConfirm');
      return true;
    },
  });
  check('a wrong phrase never reaches the final dialog', () =>
    assert.deepEqual([wrongPhrase.ok, wrongPhrase.reason, calls], [false, 'phrase-mismatch', ['askPhrase']]));
}

{
  const calls = [];
  const declinedLast = await doubleConfirm({
    askPhrase: async () => {
      calls.push('askPhrase');
      return 'WIPE ALL';
    },
    finalConfirm: async () => {
      calls.push('finalConfirm');
      return false;
    },
  });
  check('declining the last dialog aborts', () =>
    assert.deepEqual([declinedLast.ok, declinedLast.reason, calls], [false, 'cancelled', ['askPhrase', 'finalConfirm']]));
}

{
  const calls = [];
  const both = await doubleConfirm({
    askPhrase: async () => {
      calls.push('askPhrase');
      return 'wipe all';
    },
    finalConfirm: async () => {
      calls.push('finalConfirm');
      return true;
    },
  });
  check('phrase then final dialog succeeds', () =>
    assert.deepEqual([both.ok, both.step, calls], [true, 2, ['askPhrase', 'finalConfirm']]));
}

// doubleConfirm is async, so a bad call surfaces as a rejected promise, not a sync throw.
await checkAsync('doubleConfirm rejects without callbacks', () =>
  assert.rejects(() => doubleConfirm({ askPhrase: null, finalConfirm: null }), /needs askPhrase and finalConfirm/));

await checkAsync('custom phrase is honoured', async () => {
  const res = await doubleConfirm({
    askPhrase: async () => 'DELETE',
    finalConfirm: async () => true,
    phrase: 'DELETE',
  });
  assert.equal(res.ok, true);
});

console.log('single confirmation');
await checkAsync('single confirm accepted', async () => {
  const res = await singleConfirm(async () => true);
  assert.equal(res.ok, true);
});
await checkAsync('single confirm declined', async () => {
  const res = await singleConfirm(async () => false);
  assert.deepEqual([res.ok, res.reason], [false, 'cancelled']);
});
await checkAsync('singleConfirm rejects without a callback', () =>
  assert.rejects(() => singleConfirm(null), /needs a callback/));
await checkAsync('a truthy non-true answer is not consent', async () => {
  const res = await singleConfirm(async () => 'yes');
  assert.equal(res.ok, false);
});

console.log('wording');
check('the wipe-all warning names the whole history', () => {
  assert.ok(/all your history/i.test(MESSAGES.wipeAllStep1));
  assert.ok(/are you sure you want to continue\?/i.test(MESSAGES.wipeAllConfirm));
});
check('both wipe-all steps are labelled as steps', () => {
  assert.ok(/step 1 of 2/i.test(MESSAGES.wipeAllStep1));
  assert.ok(/step 2 of 2/i.test(MESSAGES.wipeAllConfirm));
});
check('the wipe-all warning says it cannot be undone', () =>
  assert.ok(/cannot be undone/i.test(MESSAGES.wipeAllConfirm)));
check('the wipe-all warning says cookies are untouched', () =>
  assert.ok(/cookies, cache, passwords and site data are not touched/i.test(MESSAGES.wipeAllStep1)));
check('the phrase message states the phrase', () =>
  assert.ok(MESSAGES.wipeAllPhrase.includes(WIPE_ALL_PHRASE)));
check('every destructive action has wording', () => {
  for (const key of ['wipeAllPhrase', 'wipeAllStep1', 'wipeAllConfirm', 'wipeNowConfirm', 'clearLogConfirm']) {
    assert.ok(typeof MESSAGES[key] === 'string' && MESSAGES[key].length > 20, `${key} missing`);
  }
  assert.ok(MESSAGES.removeRule('example.com').includes('example.com'));
  assert.ok(MESSAGES.importConfirm(3).includes('3'));
});
check('the arm window is a positive number', () => assert.ok(ARM_WINDOW_MS > 0));

console.log(`\ngate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
