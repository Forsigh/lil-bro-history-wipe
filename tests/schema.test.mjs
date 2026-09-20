// The shape of what gets saved, frozen on purpose.
//
// Adding a setting is routine, and this test will tell you the exact line to add
// here. Renaming or removing one is the thing it refuses, because an install that
// already holds the old key will be read differently afterwards, and that is how a
// working profile turns into a broken list on update. When a rename is genuinely
// needed, write the migration in store.js first, then move the key under RENAMED
// with the reason beside it.
//
// The list of types below is read off the running code, not off a plan.
//   ->  node tests/schema.test.mjs
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

const SETTINGS_TYPES = {
  enabled: 'boolean',
  mode: 'string',
  sweepExistingOnStartup: 'boolean',
  notifyOnWipe: 'boolean',
  logEnabled: 'boolean',
  logLimit: 'number',
  includeSubdomainsDefault: 'boolean',
  wipeAllHistory: 'boolean',
  listMode: 'string',
  lockEnabled: 'boolean',
  lockHash: 'string',
  lockSalt: 'string',
  lockIterations: 'number',
  extraCache: 'boolean',
  extraCookies: 'boolean',
  extraDownloads: 'boolean',
  extraFormData: 'boolean',
  extraSince: 'string',
  extraTrigger: 'string',
  popupLayout: 'string',
  advanced: 'boolean',
  lang: 'string',
  preset: 'string',
  cookieKeep: 'array',
  cookiesOnStart: 'boolean',
  cookiesOnTabClose: 'boolean',
  theme: 'string',
};

// Keys that changed name on purpose, with the migration that carries the old value
// over. Add one only together with that migration, and say where it lives.
const RENAMED = {};

// Every setting 1.3.5 shipped, from its own source in
// builds/lil-bro-history-wipe-1.3.5.zip. Nothing may leave this list: a profile
// that has one of these keys has to keep being read correctly forever.
const SETTINGS_135 = [
  'enabled', 'mode', 'sweepExistingOnStartup', 'notifyOnWipe', 'logEnabled', 'logLimit',
  'includeSubdomainsDefault', 'wipeAllHistory', 'listMode', 'lockEnabled', 'lockHash',
  'lockSalt', 'lockIterations', 'extraCache', 'extraCookies', 'extraDownloads', 'extraFormData',
  'extraSince', 'extraTrigger', 'popupLayout', 'advanced', 'preset', 'cookieKeep',
  'cookiesOnStart', 'cookiesOnTabClose', 'theme',
];

// A stored rule, as buildRule makes one.
const RULE_FIELDS = [
  'createdAt',
  'enabled',
  'id',
  'includeSubdomains',
  'type',
  'value',
  'wholeWord',
];

const kind = (v) => (Array.isArray(v) ? 'array' : typeof v);

globalThis.chrome = { storage: { local: {}, sync: {}, session: {} } };
const store = await import('../src/store.js');

const defaults = store.DEFAULT_SETTINGS;
const liveKeys = Object.keys(defaults);

console.log('the saved shape, as this build defines it');

check('every setting in the code is declared here', () => {
  const undeclared = liveKeys.filter((k) => !(k in SETTINGS_TYPES) && !(k in RENAMED));
  if (undeclared.length) {
    throw new Error(
      `new setting(s): ${undeclared.join(', ')}. Add a line to SETTINGS_TYPES, and a value to the ` +
        `1.3.5 blob in upgrade.test.mjs if one is missing.`
    );
  }
});

check('every declared setting still exists, unless a migration moved it', () => {
  const gone = Object.keys(SETTINGS_TYPES).filter((k) => !(k in defaults) && !(k in RENAMED));
  if (gone.length) throw new Error(`removed or renamed without a migration: ${gone.join(', ')}`);
});

check('each setting still holds the same kind of value', () => {
  const moved = liveKeys.filter(
    (k) => k in SETTINGS_TYPES && kind(defaults[k]) !== SETTINGS_TYPES[k]
  );
  if (moved.length) {
    throw new Error(
      moved.map((k) => `${k} is ${kind(defaults[k])}, was ${SETTINGS_TYPES[k]}`).join('; ')
    );
  }
});

check('nothing 1.3.5 wrote has been dropped since', () => {
  const lost = SETTINGS_135.filter((k) => !(k in defaults) && !(k in RENAMED));
  if (lost.length) throw new Error(`a 1.3.5 profile would lose: ${lost.join(', ')}`);
});

check('the keep list is still a list, and the PIN fields are still text', () => {
  if (!Array.isArray(defaults.cookieKeep)) throw new Error('cookieKeep is not an array');
  if (typeof defaults.lockHash !== 'string' || typeof defaults.lockSalt !== 'string') {
    throw new Error('the PIN is not stored as text any more');
  }
});

check('a stored rule still has exactly the fields the engine reads', () => {
  const rule = store.buildRule({ type: 'domain', value: 'shape.example' }).rule;
  const got = Object.keys(rule).sort();
  if (JSON.stringify(got) !== JSON.stringify([...RULE_FIELDS].sort())) {
    throw new Error(
      `rule fields changed: ${got.join(', ')}. A profile holds rules in the old shape, so a ` +
        `missing field has to be filled in when it is read, not assumed.`
    );
  }
});

check('a rule still carries its own id and createdAt, which the list depends on', () => {
  const rule = store.buildRule({ type: 'domain', value: 'shape.example' }).rule;
  if (typeof rule.id !== 'string' || !rule.id) throw new Error('no id');
  if (typeof rule.createdAt !== 'number') throw new Error('createdAt is not a number');
});

console.log(`\nschema: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
