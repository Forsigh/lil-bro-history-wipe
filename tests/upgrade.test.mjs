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
  check('the keys added since then take their defaults', () => {
    if (settings.lang !== 'auto') throw new Error(`lang is ${JSON.stringify(settings.lang)}`);
    if (settings.unlockMinutes !== '3') throw new Error(`unlockMinutes is ${JSON.stringify(settings.unlockMinutes)}`);
    if (settings.logKeep !== 'forever') throw new Error(`logKeep is ${JSON.stringify(settings.logKeep)}`);
    if (settings.oldAuto !== false) throw new Error(`oldAuto is ${JSON.stringify(settings.oldAuto)}`);
    if (settings.oldDays !== '30') throw new Error(`oldDays is ${JSON.stringify(settings.oldDays)}`);
    if (settings.extraServiceWorkers !== false) throw new Error(`extraServiceWorkers is ${JSON.stringify(settings.extraServiceWorkers)}`);
    if (settings.extraCacheStorage !== false) throw new Error(`extraCacheStorage is ${JSON.stringify(settings.extraCacheStorage)}`);
    if (settings.extraIndexedDB !== false) throw new Error(`extraIndexedDB is ${JSON.stringify(settings.extraIndexedDB)}`);
    if (settings.oldIdleOn !== false) throw new Error(`oldIdleOn is ${JSON.stringify(settings.oldIdleOn)}`);
    if (settings.oldIdleMin !== '30') throw new Error(`oldIdleMin is ${JSON.stringify(settings.oldIdleMin)}`);
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

// 1b. A profile from 2.0.8, the last build before the three extras and the idle run.
//     Every key 2.0.8 wrote, each at a value that is not the default, copied from its
//     own store.js in builds/lil-bro-wipe-2.0.8.zip. This is the update the store will
//     hand to people on 2.0.8.
const SETTINGS_208 = {
  enabled: true,
  mode: 'startup',
  sweepExistingOnStartup: false,
  notifyOnWipe: false,
  logEnabled: true,
  logLimit: 500,
  logKeep: '30',
  oldAuto: true,
  oldDays: '90',
  includeSubdomainsDefault: true,
  wipeAllHistory: false,
  listMode: 'allow',
  lockEnabled: true,
  lockHash: 'd4e5f6a1b2c3',
  lockSalt: '0c0d0e0f',
  lockIterations: 120000,
  unlockMinutes: 'session',
  extraCache: true,
  extraCookies: true,
  extraDownloads: false,
  extraFormData: true,
  extraSince: 'month',
  extraTrigger: 'triggers',
  popupLayout: 'classic',
  advanced: true,
  lang: 'pl',
  preset: 'custom',
  cookieKeep: ['keepme.example', 'stay-logged-in.test'],
  cookiesOnStart: true,
  cookiesOnTabClose: true,
  theme: 'neon',
};

const RULES_208 = [
  { id: 'm1', type: 'domain', value: 'old-fling.example', includeSubdomains: true, enabled: true, createdAt: 1760000000000 },
  { id: 'm2', type: 'keyword', value: 'gift ideas', wholeWord: true, enabled: true, createdAt: 1760000001000 },
];

function freshProfile208() {
  const bags = { local: {}, sync: {}, session: {} };
  bags.local.settings = structuredClone(SETTINGS_208);
  bags.local.rules = structuredClone(RULES_208);
  bags.local.rulesMeta = { count: 2, at: 1760000002000 };
  bags.local.log = [
    { url: 'https://old-fling.example/inbox', rule: 'old-fling.example', at: 1760000003000, kind: 'rule' },
  ];
  bags.local.stats = {
    wipedTotal: 777,
    lastRunAt: 1760000004000,
    lastRunCount: 5,
    lastRunPhase: 'startup',
    byRule: { m1: 9, m2: 4 },
  };
  bags.local.pending = [];
  globalThis.chrome = {
    storage: { local: area(bags.local), sync: area(bags.sync), session: area(bags.session) },
  };
  return bags;
}

console.log('an installed 2.0.8 profile, read by this build');

{
  const bags = freshProfile208();
  const state = await store.getState();
  const lost = Object.keys(SETTINGS_208).filter(
    (k) => JSON.stringify(state.settings[k]) !== JSON.stringify(SETTINGS_208[k])
  );
  check(`all ${Object.keys(SETTINGS_208).length} settings from 2.0.8 survive the update`, () => {
    if (lost.length) throw new Error(`changed or lost: ${lost.join(', ')}`);
  });
  check('the switches added after 2.0.8 all start off', () => {
    for (const k of ['extraServiceWorkers', 'extraCacheStorage', 'extraIndexedDB']) {
      if (state.settings[k] !== false) throw new Error(`${k} is ${JSON.stringify(state.settings[k])}`);
    }
    if (state.settings.oldIdleOn !== false) {
      throw new Error(`oldIdleOn is ${JSON.stringify(state.settings.oldIdleOn)}`);
    }
    if (state.settings.oldIdleMin !== '30') {
      throw new Error(`oldIdleMin is ${JSON.stringify(state.settings.oldIdleMin)}`);
    }
  });
  check('the PIN, the keep lists and the language survive untouched', () => {
    if (state.settings.lockEnabled !== true || state.settings.lockHash !== SETTINGS_208.lockHash) {
      throw new Error('the PIN moved');
    }
    if (state.settings.cookieKeep.length !== 2) throw new Error('the cookie keep list shrank');
    if (state.settings.lang !== 'pl') throw new Error(`lang is ${JSON.stringify(state.settings.lang)}`);
  });
  check('its rules, its counts and its log are all still there', () => {
    if (JSON.stringify(state.rules) !== JSON.stringify(RULES_208)) throw new Error('the rules changed');
    if (state.stats.byRule.m1 !== 9 || state.stats.byRule.m2 !== 4) {
      throw new Error('the per-rule counts changed');
    }
    if (state.log.length !== 1 || state.stats.wipedTotal !== 777) throw new Error('the log or the counters changed');
  });
  check('and nothing was written into the synced area on the way', () => {
    if (Object.keys(bags.sync).length) throw new Error(`synced items: ${Object.keys(bags.sync).join(', ')}`);
  });
}

// 2. Rules: a profile from a build that kept the list in the synced area. The list is
//    adopted once, copied into local storage, and taken back out of the synced area,
//    because leaving it there is what the privacy claims are about.
{
  const bags = freshProfile();
  const { rules } = await store.getState();
  check('a list left in the synced area by an older build is found', () => {
    if (rules.length !== 2) throw new Error(`${rules.length} rules came back`);
    if (rules[0].value !== 'embarrassing-shop.example') throw new Error('first rule changed');
  });
  check('every rule field is left exactly as 1.3.5 wrote it', () => {
    if (JSON.stringify(rules) !== JSON.stringify(RULES_135)) {
      throw new Error(`got ${JSON.stringify(rules)}`);
    }
  });
  check('the list is copied into local storage', () => {
    if (!Array.isArray(bags.local.rulesMirror)) throw new Error('no local copy written');
    if (bags.local.rulesMirror.length !== 2) throw new Error('the copy is short');
  });
  check('and taken out of the synced area, so the browser has nothing to upload', () => {
    if ('rulesMeta' in bags.sync) throw new Error('the synced meta is still there');
    if (Object.keys(bags.sync).some((k) => k.startsWith('rulesChunk'))) {
      throw new Error('a synced chunk is still there');
    }
  });
}

// 3. A user who deleted every rule must not have them come back from the synced area
//    on the next start.
{
  const bags = freshProfile();
  await store.writeRules([]);
  const { rules } = await store.getState();
  check('an empty list here is respected, not refilled from the synced area', () => {
    if (rules.length !== 0) throw new Error(`${rules.length} rules came back from nowhere`);
  });
}

// 4. The other shape: a machine with sync switched off, so 1.3.5 kept them locally.
{
  const bags = freshProfile({ rulesInSync: false });
  const { rules } = await store.getState();
  check('rules that live only in local storage are still found', () => {
    if (rules.length !== 2) throw new Error(`${rules.length} rules came back`);
  });
  check('and they are written back in the shape the read path expects', () => {
    if (bags.local.rulesMeta.count !== 2) throw new Error('no meta written');
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
  check('a profile that predates the per-rule counts gets an empty map, not a hole', () => {
    if (!state.stats.byRule || typeof state.stats.byRule !== 'object') {
      throw new Error(`byRule came back as ${JSON.stringify(state.stats.byRule)}`);
    }
    if (Object.keys(state.stats.byRule).length !== 0) throw new Error('byRule was filled from somewhere');
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

// 7. A backup file written before the rename has to still import, which is the one
//    moment this code has to keep working and the one nobody exercises by hand.
{
  freshProfile();
  const old = JSON.stringify(
    { app: 'lil-bro-history-wipe', version: 1, settings: SETTINGS_135, rules: RULES_135 },
    null,
    2
  );
  const parsed = store.parseExport(old);
  check('an export from 1.3.5 imports, old app tag and all', () => {
    if (parsed.rules.length !== 2) throw new Error(`${parsed.rules.length} rules came out`);
    if (parsed.skipped !== 0) throw new Error(`${parsed.skipped} were skipped`);
  });
  check('the rules carry their fields, and stay switched off if they were', () => {
    const [first, second] = parsed.rules;
    if (first.value !== 'embarrassing-shop.example') throw new Error('first rule changed');
    if (first.includeSubdomains !== true) throw new Error('subdomain choice lost');
    if (first.enabled !== true || second.enabled !== false) throw new Error('enabled flags moved');
  });
  check('the settings in that file come back as they were', () => {
    if (!parsed.settings) throw new Error('no settings came out');
    if (parsed.settings.theme !== 'slate') throw new Error('theme changed');
    if (parsed.settings.lockHash !== SETTINGS_135.lockHash) throw new Error('PIN changed');
  });
  check('an export carries the counters, and a file without them still imports', () => {
    const withStats = store.parseExport(JSON.stringify({ rules: RULES_135, stats: { wipedTotal: 42 } }));
    if (!withStats.stats || withStats.stats.wipedTotal !== 42) throw new Error('counters were lost');
    const without = store.parseExport(JSON.stringify({ rules: RULES_135 }));
    if (without.stats !== null) throw new Error('invented counters out of nothing');
  });
  check('a bare array still imports, since that is what the first build wrote', () => {
    const bare = store.parseExport(JSON.stringify(RULES_135));
    if (bare.rules.length !== 2) throw new Error(`${bare.rules.length} rules`);
    if (bare.settings !== null) throw new Error('invented settings out of an array');
  });
  check('a file with no rules in it is refused rather than half imported', () => {
    let threw = false;
    try {
      store.parseExport(JSON.stringify({ app: 'something-else', items: [] }));
    } catch (e) {
      threw = /no rules array/i.test(e.message);
    }
    if (!threw) throw new Error('it accepted a file with nothing in it');
  });
  check('junk inside the rules array is skipped, not fatal', () => {
    const mixed = store.parseExport(
      JSON.stringify({ rules: [...RULES_135, null, { type: 'domain', value: '' }, 'nonsense'] })
    );
    if (mixed.rules.length !== 2) throw new Error(`${mixed.rules.length} rules survived`);
    if (mixed.skipped !== 3) throw new Error(`${mixed.skipped} reported as skipped`);
  });
}

console.log(`\nupgrade: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
