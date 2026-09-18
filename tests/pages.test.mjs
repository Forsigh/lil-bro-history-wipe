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
  const sources = ['options.js', 'popup.js', 'service-worker.js', 'lock.js', 'store.js'];
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

// Rule types offered in the UI must exist in the engine's vocabulary. Only the
// rule builder's own select counts: the page has other selects now.
const typeBlock = storeSrc.match(/export const RULE_TYPES = \{([\s\S]*?)\n\};/);
const ruleTypeBlock = readFileSync(join(root, 'options.html'), 'utf8').match(
  /<select id="ruleType">([\s\S]*?)<\/select>/
);
if (!ruleTypeBlock) {
  console.log('  FAIL options.html has no #ruleType select');
  fail++;
}
const uiTypes = ruleTypeBlock
  ? [...ruleTypeBlock[1].matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1])
  : [];
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

// The deletion surface, in full. history.deleteAll is confined to the one
// opt-in wipe-all path; chrome.browsingData is confined to the one extra-clear
// path, which is off by default and never runs on a visit. Cookie and download
// APIs beyond that are never granted, and passwords are never promised at all:
// Chrome removed password deletion from browsingData in Chrome 144.
const EXPECTED_PERMISSIONS = ['history', 'storage', 'notifications', 'contextMenus', 'activeTab', 'browsingData'];
const actualPerms = [...manifest.permissions].sort();
if (JSON.stringify(actualPerms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) {
  console.log(`  FAIL permission set changed: ${actualPerms.join(', ')}`);
  fail++;
}
for (const banned of ['cookies', 'downloads', 'sessions', 'tabs', 'management', 'declarativeNetRequest']) {
  if (manifest.permissions.includes(banned)) {
    console.log(`  FAIL "${banned}" permission would widen what the extension can delete`);
    fail++;
  }
}
const workerSrc = readFileSync(join(root, 'service-worker.js'), 'utf8');
// Comments explain the rules and may name the very APIs the code must not call,
// so every "must not appear" check runs against the code with comments removed.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const workerCode = stripComments(workerSrc);
for (const banned of ['deleteRange', 'removeHistory', 'removeCookies', 'removeCache', 'removePasswords', 'removePluginData', 'removeWebSQL', 'passwords:']) {
  if (workerCode.includes(banned)) {
    console.log(`  FAIL service-worker.js references "${banned}" — that deletion path must stay out of reach`);
    fail++;
  }
}
const browsingDataCalls = (workerCode.match(/chrome\.browsingData\.remove\(/g) || []).length;
if (browsingDataCalls !== 1) {
  console.log(`  FAIL chrome.browsingData.remove appears ${browsingDataCalls} times, expected exactly 1`);
  fail++;
}
const clearStart = workerSrc.indexOf('async function clearExtra');
const clearEnd = workerSrc.indexOf('async function', clearStart + 10);
const clearBody = clearStart === -1 ? '' : workerSrc.slice(clearStart, clearEnd === -1 ? undefined : clearEnd);
if (clearStart === -1 || !clearBody.includes('chrome.browsingData.remove(')) {
  console.log('  FAIL the single browsingData call is not inside clearExtra()');
  fail++;
}
const outsideClear = stripComments(
  clearStart === -1
    ? workerSrc
    : workerSrc.slice(0, clearStart) + workerSrc.slice(clearEnd === -1 ? workerSrc.length : clearEnd)
);
if (outsideClear.includes('browsingData')) {
  console.log('  FAIL browsingData code lives outside clearExtra() — one funnel only');
  fail++;
}
if (!clearBody.includes('extraSelection(settings)')) {
  console.log('  FAIL clearExtra() no longer takes its data set from extraSelection()');
  fail++;
}
// deleteAll is permitted in exactly one place: the opt-in wipe-all path.
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
  '  deletion scope: rules = deleteUrl, deleteAll confined to wipeEverything(), browsingData confined to clearExtra()'
);

// The extra clear is opt-in. A default that ships switched on would clear cookies
// for someone who never asked, which is the one thing this build must not do.
for (const key of ['extraCache', 'extraCookies', 'extraDownloads', 'extraFormData']) {
  if (!new RegExp(`${key}: false`).test(storeSrc)) {
    console.log(`  FAIL ${key} does not default to false`);
    fail++;
  }
}
if (!/extraTrigger: 'manual'/.test(storeSrc)) {
  console.log("  FAIL extraTrigger no longer defaults to 'manual' — the extra clear could fire at a trigger unasked");
  fail++;
}
if (!storeSrc.includes('extraSinceMs')) {
  console.log('  FAIL store.js lost extraSinceMs — the reach of a clear would be unbounded');
  fail++;
}
console.log('  extra clear: four kinds off by default, manual trigger, one funnel, no passwords');

// Every destructive surface must go through the confirmation gates. Each page has
// exactly two sendMessage call sites now: the wipe funnel, and the extra clear
// with its own confirmation.
const optionsSrc = readFileSync(join(root, 'options.js'), 'utf8');
const popupSrc = readFileSync(join(root, 'popup.js'), 'utf8');

for (const [file, src, needed] of [
  [
    'options.js',
    optionsSrc,
    ['confirm-gate.js', 'doubleConfirm', 'singleConfirm', 'await confirmDestructive()', 'MESSAGES.wipeAllStep1', 'MESSAGES.wipeNowConfirm', 'MESSAGES.clearLogConfirm', 'MESSAGES.removeRule', 'MESSAGES.importConfirm', 'now, covering', 'describeExtras(state.settings)'],
  ],
  [
    'popup.js',
    popupSrc,
    ['confirm-gate.js', 'requestRun(', 'checkPhrase(', 'secondClickWithin(', 'MESSAGES.wipeAllStep2', "sendMessage({ type: 'clearExtra' }", 'extraOn('],
  ],
]) {
  for (const needle of needed) {
    if (!src.includes(needle)) {
      console.log(`  FAIL ${file} no longer references "${needle}" — a confirmation gate may be missing`);
      fail++;
    }
  }
  const sends = (src.match(/chrome\.runtime\.sendMessage\(/g) || []).length;
  if (sends !== 2) {
    console.log(`  FAIL ${file} has ${sends} sendMessage call sites, expected 2 (wipe funnel + confirmed extra clear)`);
    fail++;
  }
}
if (!readFileSync(join(root, 'service-worker.js'), 'utf8').includes('settings.wipeAllHistory')) {
  console.log('  FAIL the worker no longer reads the wipe-all setting');
  fail++;
}
console.log('  confirmations: gates wired in options.js and popup.js, two sendMessage funnels each');

// The lock is only a lock if (a) the sections that name a site are marked for it,
// (b) both pages verify a PIN, (c) the PIN is hashed rather than stored, and
// (d) the list goes off the screen the moment a PIN is set, not on the next reload.
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
if (!optionsSrc.includes('lockNowBtn')) {
  console.log('  FAIL the options page lost the "hide the list now" control');
  fail++;
}
if (!/unlocked = false;[\s\S]{0,220}await load\(\)/.test(optionsSrc.slice(optionsSrc.indexOf("$('lockSave')")))) {
  console.log('  FAIL saving a PIN no longer hides the list straight away — the lock would look broken');
  fail++;
}
if (!/if \(isLocked\(\)\) \{[\s\S]{0,400}rulesBody'\)\.innerHTML = ''/.test(optionsSrc)) {
  console.log('  FAIL the options page no longer blanks the rule rows while locked');
  fail++;
}
if (!workerSrc.includes('notifyLockedMenu') || !/settings\.lockEnabled[\s\S]{0,120}notifyLockedMenu/.test(workerSrc)) {
  console.log('  FAIL the context menu can edit the list while the lock is on');
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
if (!lockSrc.includes('RECOVERY_WORD')) {
  console.log('  FAIL lock.js has no RECOVERY_WORD — a forgotten PIN would be unrecoverable');
  fail++;
}
if (!storeSrc.includes('export async function factoryReset')) {
  console.log('  FAIL store.js has no factoryReset — the recovery path would have nothing to call');
  fail++;
}
for (const file of ['options.js', 'popup.js']) {
  const src = readFileSync(join(root, file), 'utf8');
  if (!src.includes('checkRecovery(') || !src.includes('factoryReset(')) {
    console.log(`  FAIL ${file} lost the forgotten-PIN way out`);
    fail++;
  }
}
console.log('  lock: list sections gated, PIN hashed, lock takes hold at once, menu cannot edit around it');

// The popup is compact by default and can be put back to the classic layout, so a
// redesign never hides a control away with no way to see the old one again.
if (!popupHtml.includes('id="layoutBtn"') || !popupSrc.includes("popupLayout")) {
  console.log('  FAIL the popup lost its compact/classic switch');
  fail++;
}
if (!readFileSync(join(root, 'styles.css'), 'utf8').includes('body.layout-classic .more')) {
  console.log('  FAIL styles.css cannot show the classic popup layout');
  fail++;
}

console.log(fail === 0 ? '\npages: ok' : `\npages: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
