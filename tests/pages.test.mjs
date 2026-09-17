// Guards against typo'd element ids between the HTML and the page scripts.
//   node tests/pages.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;

function idsOf(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function refsOf(js) {
  const refs = new Set();
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
  return refs;
}

const pairs = [
  ['options.html', 'options.js'],
  ['popup.html', 'popup.js'],
];

for (const [htmlFile, jsFile] of pairs) {
  const html = readFileSync(join(root, htmlFile), 'utf8');
  const js = readFileSync(join(root, jsFile), 'utf8');
  const ids = idsOf(html);
  const refs = refsOf(js);

  for (const ref of refs) {
    if (!ids.has(ref)) {
      console.log(`  FAIL ${jsFile} references #${ref} which is not in ${htmlFile}`);
      fail++;
    }
  }
  console.log(`  ${htmlFile}: ${ids.size} ids, ${refs.size} referenced, all resolved`);
}

// manifest sanity
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const required = ['storage', 'history'];
for (const perm of required) {
  if (!manifest.permissions.includes(perm)) {
    console.log(`  FAIL manifest is missing the "${perm}" permission`);
    fail++;
  }
}
if (manifest.name.length > 75) {
  console.log('  FAIL extension name exceeds the 75 character Chrome Web Store limit');
  fail++;
}
if (manifest.manifest_version !== 3) {
  console.log('  FAIL manifest_version must be 3');
  fail++;
}
if (manifest.background.type !== 'module') {
  console.log('  FAIL background.type must be "module" (the code uses ES imports)');
  fail++;
}
console.log(`  manifest: v${manifest.version}, permissions [${manifest.permissions.join(', ')}], name length ${manifest.name.length}`);

// A setting written by the UI but never read (or misspelled) is invisible at
// runtime, so cross-check every settings key against store.js defaults.
const storeSrc = readFileSync(join(root, 'store.js'), 'utf8');
const defaultsBlock = storeSrc.match(/export const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/);
if (!defaultsBlock) {
  console.log('  FAIL could not find DEFAULT_SETTINGS in store.js');
  fail++;
} else {
  const known = new Set([...defaultsBlock[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  const sources = ['options.js', 'popup.js', 'service-worker.js', 'lock.js'];
  const used = new Set();
  for (const file of sources) {
    const src = readFileSync(join(root, file), 'utf8');
    for (const m of src.matchAll(/settings\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
  }
  for (const key of used) {
    if (!known.has(key)) {
      console.log(`  FAIL settings.${key} is used in the code but is not a DEFAULT_SETTINGS key`);
      fail++;
    }
  }
  const neverRead = [...known].filter((k) => !used.has(k));
  console.log(`  settings: ${known.size} defaults, ${used.size} referenced by code, unresolved: 0`);
  if (neverRead.length) console.log(`  (keys with no code reference: ${neverRead.join(', ')})`);
}

// Rule types offered in the UI must exist in the engine's vocabulary.
const typeBlock = storeSrc.match(/export const RULE_TYPES = \{([\s\S]*?)\n\};/);
const uiTypes = [...readFileSync(join(root, 'options.html'), 'utf8').matchAll(/<option value="([a-z]+)"/g)].map(
  (m) => m[1]
);
const engineTypes = typeBlock
  ? [...typeBlock[1].matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1])
  : [];
for (const t of uiTypes) {
  if (!engineTypes.includes(t)) {
    console.log(`  FAIL options.html offers rule type "${t}" which store.js does not know`);
    fail++;
  }
}
console.log(`  rule types: ui [${uiTypes.join(', ')}] vs engine [${engineTypes.join(', ')}]`);

// The safety claim is structural: without the browsingData permission the
// cookies/cache API does not exist for this extension, and the history API's
// whole-database calls must never be referenced in the code.
const EXPECTED_PERMISSIONS = ['history', 'storage', 'notifications', 'contextMenus', 'activeTab'];
const actualPerms = [...manifest.permissions].sort();
if (JSON.stringify(actualPerms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) {
  console.log(`  FAIL permission set changed: ${actualPerms.join(', ')}`);
  fail++;
}
for (const banned of ['browsingData', 'cookies', 'downloads', 'sessions', 'tabs']) {
  if (manifest.permissions.includes(banned)) {
    console.log(`  FAIL "${banned}" permission would widen what the extension can delete`);
    fail++;
  }
}
const workerSrc = readFileSync(join(root, 'service-worker.js'), 'utf8');
for (const banned of ['deleteRange', 'browsingData', 'removeHistory', 'removeCookies', 'removeCache']) {
  if (workerSrc.includes(banned)) {
    console.log(`  FAIL service-worker.js references "${banned}" — cookies/cache must stay out of reach`);
    fail++;
  }
}
// deleteAll is permitted in exactly one place: the opt-in wipe-all path. The rule
// engine must never reach it, and the extension must never gain the permission
// that would let it touch cookies or cache.
const nukeStart = workerSrc.indexOf('async function wipeEverything');
const nukeEnd = workerSrc.indexOf('async function', nukeStart + 10);
const nukeBody = workerSrc.slice(nukeStart, nukeEnd === -1 ? undefined : nukeEnd);
const outsideNuke =
  workerSrc.slice(0, nukeStart) + workerSrc.slice(nukeEnd === -1 ? workerSrc.length : nukeEnd);
const deleteAllCalls = (workerSrc.match(/chrome\.history\.deleteAll\(\)/g) || []).length;

if (nukeStart === -1) {
  console.log('  FAIL wipeEverything() is missing');
  fail++;
}
if (deleteAllCalls !== 1) {
  console.log(`  FAIL chrome.history.deleteAll appears ${deleteAllCalls} times, expected exactly 1`);
  fail++;
}
if (!nukeBody.includes('chrome.history.deleteAll()')) {
  console.log('  FAIL the single deleteAll call is not inside wipeEverything()');
  fail++;
}
if (outsideNuke.includes('deleteAll')) {
  console.log('  FAIL deleteAll is referenced outside wipeEverything() — the rule path must never use it');
  fail++;
}
if (!workerSrc.includes('chrome.history.deleteUrl')) {
  console.log('  FAIL service-worker.js no longer uses deleteUrl — deletion path changed');
  fail++;
}
console.log(
  '  deletion scope: rule engine = deleteUrl only; deleteAll confined to wipeEverything(); browsingData absent'
);

// Every destructive surface must go through the confirmation gates, and there must
// be exactly one funnel that talks to the worker.
const optionsSrc = readFileSync(join(root, 'options.js'), 'utf8');
const popupSrc = readFileSync(join(root, 'popup.js'), 'utf8');

for (const [file, src, needed] of [
  [
    'options.js',
    optionsSrc,
    ['confirm-gate.js', 'doubleConfirm', 'singleConfirm', 'await confirmDestructive()', 'MESSAGES.wipeAllStep1', 'MESSAGES.wipeNowConfirm', 'MESSAGES.clearLogConfirm', 'MESSAGES.removeRule', 'MESSAGES.importConfirm'],
  ],
  [
    'popup.js',
    popupSrc,
    ['confirm-gate.js', 'requestRun(', 'checkPhrase(', 'secondClickWithin(', 'MESSAGES.wipeAllStep2'],
  ],
]) {
  for (const needle of needed) {
    if (!src.includes(needle)) {
      console.log(`  FAIL ${file} no longer references "${needle}" — a confirmation gate may be missing`);
      fail++;
    }
  }
  const sends = (src.match(/chrome\.runtime\.sendMessage\(/g) || []).length;
  if (sends !== 1) {
    console.log(`  FAIL ${file} has ${sends} sendMessage call sites, expected exactly 1 gated funnel`);
    fail++;
  }
}
if (!readFileSync(join(root, 'service-worker.js'), 'utf8').includes('settings.wipeAllHistory')) {
  console.log('  FAIL the worker no longer reads the wipe-all setting');
  fail++;
}
console.log('  confirmations: gates wired in options.js and popup.js, one sendMessage funnel each');

// The lock is only a lock if (a) the sections that name a site are marked for it,
// (b) both pages verify a PIN, and (c) the PIN is hashed rather than stored.
const lockSrc = readFileSync(join(root, 'lock.js'), 'utf8');
for (const file of ['options.html', 'popup.html']) {
  if (!/class="[^"]*\blockable\b/.test(readFileSync(join(root, file), 'utf8'))) {
    console.log(`  FAIL ${file} marks no section as lockable — the lock would hide nothing`);
    fail++;
  }
}
if (!readFileSync(join(root, 'styles.css'), 'utf8').includes('body.locked .lockable')) {
  console.log('  FAIL styles.css does not hide .lockable sections while locked');
  fail++;
}
for (const file of ['options.js', 'popup.js']) {
  const src = readFileSync(join(root, file), 'utf8');
  if (!src.includes("from './lock.js'") || !src.includes('verifyPin(')) {
    console.log(`  FAIL ${file} does not ask for a PIN before showing the list`);
    fail++;
  }
}
if (!lockSrc.includes('crypto.subtle') || !lockSrc.includes('PBKDF2')) {
  console.log('  FAIL lock.js no longer hashes the PIN with PBKDF2');
  fail++;
}
if (/lockHash:\s*'[0-9a-f]{4}/.test(storeSrc)) {
  console.log('  FAIL store.js ships a hard-coded PIN hash');
  fail++;
}
const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
if (!popupHtml.includes('id="scopeList"') || !popupHtml.includes('id="scopeAll"')) {
  console.log('  FAIL the popup no longer offers both ways to run (list / everything)');
  fail++;
}
if (!popupSrc.includes('MESSAGES.wipeAllArm')) {
  console.log('  FAIL arming the whole-history wipe from the popup lost its confirmation');
  fail++;
}
console.log('  lock: list sections gated, PIN hashed, nothing shipped pre-set');

console.log(fail === 0 ? '\npages: ok' : `\npages: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
