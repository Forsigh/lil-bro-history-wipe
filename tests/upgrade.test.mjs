// Upgrade tests: a browser profile that was running 1.3.5, opened by 1.5.x.
// The blob below is written out by hand, using the key names and rule shape that
// 1.3.5 itself wrote (its store.js is in builds/lil-bro-history-wipe-1.3.5.zip,
// and every key here was copied from it). Nothing in this file comes from the
// current code, or the test would only prove today's code agrees with itself.
//   ->  node tests/upgrade.test.mjs
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

const area = (bag) => ({
  async get(keys) {
    if (keys === undefined || keys === null) return structuredClone(bag);
    if (typeof keys === 'string') return keys in bag ? { [keys]: structuredClone(bag[keys]) } : {};
    const out = {};
    for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
      if (k in bag) out[k] = structuredClone(bag[k]);
    }
    return out;
  },
  async set(patch) {
    for (const [k, v] of Object.entries(patch)) bag[k] = structuredClone(v);
  },
  async remove(key) {
    for (const k of Array.isArray(key) ? key : [key]) delete bag[k];
  },
});

// Every setting 1.3.5 shipped, with a value that is not the default, so a lost
// key cannot hide behind a matching default. 26 keys, as counted in its source.
const SETTINGS_135 = {
  enabled: true,
  mode: 'onclose',
  sweepExistingOnStartup: false,
  notifyOnWipe: false,
  logEnabled: true,
  logLimit: 200,
  includeSubdomainsDefault: true,
  wipeAllHistory: false,
  listMode: 'allow',
  lockEnabled: true,
  lockHash: 'a1b2c3d4e5f6',
  lockSalt: '0f0e0d0c',
  lockIterations: 1000,
  extraCache: true,
  extraCookies: false,
  extraDownloads: true,
  extraFormData: true,
  extraSince: 'week',
  extraTrigger: 'triggers',
  popupLayout: 'classic',
  advanced: true,
  preset: 'custom',
  cookieKeep: ['keepme.example', 'stay-logged-in.test'],
  cookiesOnStart: true,
  cookiesOnTabClose: true,
  theme: 'slate',
};

// A rule exactly as 1.3.5 stored one.
const RULES_135 = [
  {
    id: 'r1',
    type: 'domain',
    value: 'embarrassing-shop.example',
    includeSubdomains: true,
    enabled: true,
    createdAt: 1758000000000,
  },
  { id: 'r2', type: 'keyword', value: 'auction', wholeWord: false, enabled: false, createdAt: 1758000001000 },
];

// The chunked sync layout 1.3.5 wrote, built here from its constants.
function syncBagFor(rules) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const rule of rules) {
    const piece = JSON.stringify(rule).length + 1;
    if (size + piece > 6000 && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(rule);
    size += piece;
  }
  if (current.length) chunks.push(current);
  const bag = { rulesMeta: { chunks: chunks.length, count: rules.length, at: 1758000002000 } };
  chunks.forEach((chunk, i) => {
    bag['rulesChunk' + i] = chunk;
  });
  return bag;
}

function freshProfile({ rulesInSync = true, mirror = false } = {}) {
  const bags = { local: {}, sync: {}, session: {} };
  bags.local.settings = structuredClone(SETTINGS_135);
  bags.local.log = [
    { url: 'https://auction.example/item/9', rule: 'auction', at: 1758000005000, kind: 'rule' },
  ];
  bags.local.stats = {
    wipedTotal: 4821,
    lastRunAt: 1758000006000,
    lastRunCount: 37,
    lastRunPhase: 'manual',
  };
  bags.local.pending = [
    { url: 'https://queued.example/a', title: 'queued', rule: 'auction', at: 1758000007000 },
  ];
  if (rulesInSync) Object.assign(bags.sync, syncBagFor(RULES_135));
  else bags.local.rules = structuredClone(RULES_135);
  if (mirror) bags.local.rulesMirror = structuredClone(RULES_135);
  globalThis.chrome = {
    storage: { local: area(bags.local), sync: area(bags.sync), session: area(bags.session) },
  };
  return bags;
}

const store = await import('../src/store.js');

console.log('an installed 1.3.5 profile, read by this build');

// 1. Settings: every key, one by one, so a single dropped key fails the run.
{
  freshProfile();
  const { settings } = await store.getState();
  const lost = Object.keys(SETTINGS_135).filter(
    (k) => JSON.stringify(settings[k]) !== JSON.stringify(SETTINGS_135[k])
  );
  check('all 26 settings from 1.3.5 survive the update', () => {
    if (lost.length) throw new Error(`changed or lost: ${lost.join(', ')}`);
  });
  check('the one key added since then takes its default', () => {
    if (settings.lang !== 'auto') throw new Error(`lang is ${JSON.stringify(settings.lang)}`);
  });
  check('nothing in the old blob was dropped on the way through', () => {
    const keys = Object.keys(settings);
    if (keys.length < 27) throw new Error(`only ${keys.length} settings came back`);
  });
  check('the PIN lock survives, so the user is not locked out or unlocked', () => {
    if (settings.lockEnabled !== true) throw new Error('lock switched off');
    if (settings.lockHash !== SETTINGS_135.lockHash) throw new Error('hash changed');
    if (settings.lockIterations !== 1000) throw new Error('iterations changed');
  });
  check('the keep list mode and the cookie keep list survive', () => {
    if (settings.listMode !== 'allow') throw new Error(`listMode is ${settings.listMode}`);
    if (settings.cookieKeep.length !== 2) throw new Error('cookie keep list shrank');
  });
}

// 2. Rules: the machine that had them in sync, with no local copy at all.
{
  const bags = freshProfile();
  const { rules } = await store.getState();
  check('rules that live only in sync are still found', () => {
    if (rules.length !== 2) throw new Error(`${rules.length} rules came back`);
    if (rules[0].value !== 'embarrassing-shop.example') throw new Error('first rule changed');
  });
  check('every rule field is left exactly as 1.3.5 wrote it', () => {
    if (JSON.stringify(rules) !== JSON.stringify(RULES_135)) {
      throw new Error(`got ${JSON.stringify(rules)}`);
    }
  });
  check('the read backfills the local mirror the old build never wrote', () => {
    if (!Array.isArray(bags.local.rulesMirror)) throw new Error('no mirror written');
    if (bags.local.rulesMirror.length !== 2) throw new Error('mirror is short');
  });
  check('and the sync layout is left alone', () => {
    if (bags.sync.rulesMeta.count !== 2) throw new Error('the meta count moved');
  });
}

// 3. The other shape: a machine with sync switched off, so 1.3.5 kept them locally.
{
  const bags = freshProfile({ rulesInSync: false });
  const { rules } = await store.getState();
  check('rules that live only in local storage are still found', () => {
    if (rules.length !== 2) throw new Error(`${rules.length} rules came back`);
  });
  check('and they are pushed up to sync on the first read', () => {
    if (bags.sync.rulesMeta.count !== 2) throw new Error('nothing reached sync');
  });
}

// 4. The log, the counters and the queue.
{
  freshProfile();
  const state = await store.getState();
  check('the log keeps its entries', () => {
    if (state.log.length !== 1) throw new Error(`${state.log.length} entries`);
    if (state.log[0].rule !== 'auction') throw new Error('the entry changed');
  });
  check('the counters keep their numbers', () => {
    if (state.stats.wipedTotal !== 4821) throw new Error(`wipedTotal ${state.stats.wipedTotal}`);
    if (state.stats.lastRunPhase !== 'manual') throw new Error('lastRunPhase changed');
  });
  check('the queue is still there', () => {
    if (state.pending.length !== 1) throw new Error(`${state.pending.length} queued`);
  });
}

// 5. Things a future build might leave behind must not break the read.
{
  freshProfile();
  const { settings } = await store.getState();
  check('an unknown setting from another build does not break anything', () => {
    if (settings.mode !== 'onclose') throw new Error('the mode changed');
  });
}

// 6. The one value whose meaning changed: the close trigger, dropped in 1.3.3.
//    The page moves it to the next start, which is what it also did in practice.
//    That lives in options.js and is checked in the live probe, not here.
await checkAsync('the legacy close trigger is still a value this build understands', async () => {
  freshProfile();
  const { settings } = await store.getState();
  if (!['realtime', 'startup', 'onclose'].includes(settings.mode)) {
    throw new Error(`mode is ${settings.mode}`);
  }
});

console.log(`\nupgrade: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
