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
  ['src/options.html', 'src/options.js'],
  ['src/popup.html', 'src/popup.js'],
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
const storeSrc = readFileSync(join(root, 'src/store.js'), 'utf8');
const defaultsBlock = storeSrc.match(/export const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/);
if (!defaultsBlock) {
  console.log('  FAIL could not find DEFAULT_SETTINGS in store.js');
  fail++;
} else {
  const known = new Set([...defaultsBlock[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  const sources = ['src/options.js', 'src/popup.js', 'src/service-worker.js', 'src/lock.js', 'src/store.js'];
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
const ruleTypeBlock = readFileSync(join(root, 'src/options.html'), 'utf8').match(
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
const EXPECTED_PERMISSIONS = [
  'history',
  'storage',
  'notifications',
  'contextMenus',
  'activeTab',
  'browsingData',
  'cookies',
];
const actualPerms = [...manifest.permissions].sort();
if (JSON.stringify(actualPerms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) {
  console.log(`  FAIL permission set changed: ${actualPerms.join(', ')}`);
  fail++;
}
for (const banned of ['downloads', 'sessions', 'tabs', 'management', 'declarativeNetRequest']) {
  if (manifest.permissions.includes(banned)) {
    console.log(`  FAIL "${banned}" permission would widen what the extension can delete`);
    fail++;
  }
}
// tabs is optional on purpose: asking for it at install time would add a warning
// and disable the extension for everyone who already has it.
if (!(manifest.optional_permissions || []).includes('tabs')) {
  console.log('  FAIL tabs should be an optional permission, requested only for the tab-close cookie rule');
  fail++;
}
if (manifest.permissions.includes('tabs')) {
  console.log('  FAIL tabs must not be a required permission');
  fail++;
}
const workerSrc = readFileSync(join(root, 'src/service-worker.js'), 'utf8');
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
// The cookie API is confined to the worker's cookie section, and nothing in a page
// ever touches a cookie. Only the options page may ask for the optional tabs
// permission, and only from a click.
const cookieCalls = (workerCode.match(/chrome\.cookies\.remove\(/g) || []).length;
const cookieStart = workerSrc.indexOf('// cookies');
const cookieEnd = workerSrc.indexOf('async function ensureMenus');
const cookieBody = cookieStart === -1 ? '' : workerSrc.slice(cookieStart, cookieEnd);
const cookieOutside = stripComments(
  cookieStart === -1 ? workerSrc : workerSrc.slice(0, cookieStart) + workerSrc.slice(cookieEnd)
);
if (cookieCalls !== 2 || !cookieBody.includes('chrome.cookies.remove(')) {
  console.log(`  FAIL chrome.cookies.remove appears ${cookieCalls} times, expected 2 inside the cookie section`);
  fail++;
}
if (cookieOutside.includes('chrome.cookies')) {
  console.log('  FAIL cookie code lives outside the cookie section');
  fail++;
}
for (const page of ['src/options.js', 'src/popup.js']) {
  if (readFileSync(join(root, page), 'utf8').includes('chrome.cookies')) {
    console.log(`  FAIL ${page} touches chrome.cookies — pages only send messages`);
    fail++;
  }
}
if (workerCode.includes('chrome.permissions.request')) {
  console.log('  FAIL the worker asks for permissions; only a page can, and only from a click');
  fail++;
}
if (!readFileSync(join(root, 'src/options.js'), 'utf8').includes('chrome.permissions.request')) {
  console.log('  FAIL nothing asks for the optional tabs permission');
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
const optionsSrc = readFileSync(join(root, 'src/options.js'), 'utf8');
const popupSrc = readFileSync(join(root, 'src/popup.js'), 'utf8');

for (const [file, src, needed] of [
  [
    'src/options.js',
    optionsSrc,
    ['confirm-gate.js', 'doubleConfirm', 'singleConfirm', 'await confirmDestructive()', 'MESSAGES.wipeAllStep1', 'MESSAGES.wipeNowConfirm', 'MESSAGES.clearLogConfirm', 'MESSAGES.removeRule', 'MESSAGES.importConfirm', 'now, covering', 'describeExtras(state.settings)'],
  ],
  [
    'src/popup.js',
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
  const expected = file === 'src/options.js' ? 3 : 2;
  if (sends !== expected) {
    console.log(`  FAIL ${file} has ${sends} sendMessage call sites, expected ${expected}`);
    fail++;
  }
}
if (!optionsSrc.includes('Clear cookies for everything except') || !optionsSrc.includes("type: 'pruneCookies'")) {
  console.log('  FAIL the manual cookie clear lost its confirmation or its message');
  fail++;
}
if (!readFileSync(join(root, 'src/service-worker.js'), 'utf8').includes('settings.wipeAllHistory')) {
  console.log('  FAIL the worker no longer reads the wipe-all setting');
  fail++;
}
console.log('  confirmations: gates wired in options.js and popup.js, two sendMessage funnels each');

// The lock is only a lock if (a) the sections that name a site are marked for it,
// (b) both pages verify a PIN, (c) the PIN is hashed rather than stored, and
// (d) the list goes off the screen the moment a PIN is set, not on the next reload.
const lockSrc = readFileSync(join(root, 'src/lock.js'), 'utf8');
for (const file of ['src/options.html', 'src/popup.html']) {
  if (!/class="[^"]*\blockable\b/.test(readFileSync(join(root, file), 'utf8'))) {
    console.log(`  FAIL ${file} marks no section as lockable — the lock would hide nothing`);
    fail++;
  }
}
if (!readFileSync(join(root, 'src/styles.css'), 'utf8').includes('body.locked .lockable')) {
  console.log('  FAIL styles.css does not hide .lockable sections while locked');
  fail++;
}
for (const file of ['src/options.js', 'src/popup.js']) {
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
const popupHtml = readFileSync(join(root, 'src/popup.html'), 'utf8');
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
for (const file of ['src/options.js', 'src/popup.js']) {
  const src = readFileSync(join(root, file), 'utf8');
  if (!src.includes('checkRecovery(') || !src.includes('factoryReset(')) {
    console.log(`  FAIL ${file} lost the forgotten-PIN way out`);
    fail++;
  }
}
console.log('  lock: list sections gated, PIN hashed, lock takes hold at once, menu cannot edit around it');

// The popup says what happens to the tab in front of you, and it asks the same
// matcher the worker asks, so that line cannot drift from what really happens.
if (!popupHtml.includes('id="siteVerdict"')) {
  console.log('  FAIL the popup no longer says what happens to the current tab');
  fail++;
}
if (!popupSrc.includes("from './matcher.js'") || !popupSrc.includes('findMatch(')) {
  console.log('  FAIL the popup verdict no longer goes through the matcher');
  fail++;
}
if (/layoutBtn|moreBtn|applyLayout|setMore/.test(popupSrc) || popupHtml.includes('id="layoutBtn"')) {
  console.log('  FAIL the dead compact/classic layout is still wired up');
  fail++;
}

// The verdict keys are chosen at runtime (t(key)), so a typo in the code would
// reach the screen as an empty line. Both halves are checked: the key has to be
// in popup.js, and in every bundle.
const bundleFor = (loc) =>
  JSON.parse(readFileSync(join(root, '_locales', loc, 'messages.json'), 'utf8'));
const VERDICT_KEYS = [
  'siteCleanedNow',
  'siteCleanedStart',
  'siteKept',
  'siteNotListed',
  'siteAll',
  'sitePaused',
  'siteNoSite',
];
for (const key of VERDICT_KEYS) {
  if (!popupSrc.includes(`'${key}'`)) {
    console.log(`  FAIL popup.js never asks for the verdict key "${key}"`);
    fail++;
  }
  for (const loc of ['en', 'pl']) {
    if (!bundleFor(loc)[key]) {
      console.log(`  FAIL the verdict key "${key}" is missing from _locales/${loc}`);
      fail++;
    }
  }
}
console.log(`  popup verdict: ${VERDICT_KEYS.length} keys wired, present in both bundles`);

// A theme button draws its own preview, so its colours are a copy of that theme's
// tokens, and a copy drifts: paper's swatch kept #9a6b2f long after the token moved to
// #8f6129. This checks every swatch against the theme block it claims to preview.
const cssSrc = readFileSync(join(root, 'src/styles.css'), 'utf8');
const tokensFrom = (body) => {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};
const baseTokens = tokensFrom(cssSrc.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
const autoLight = tokensFrom(
  cssSrc.match(/@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme='auto'\] \{([\s\S]*?)\n  \}/)[1]
);
// auto is the one swatch that shows two page colours, because auto is a mode: the
// dark page next to the light one it switches to. Its second colour is the light
// override, so that is what gets checked against the media query.
const themeTokens = { auto: { ...baseTokens }, dark: { ...baseTokens } };
// The light override for auto sits in its own media query, and it is also a
// :root[data-theme='auto'] block, so it has to be out of the way before the per-theme
// scan or it overwrites auto with the light tokens.
const withoutAutoLight = cssSrc.replace(/@media \(prefers-color-scheme: light\) \{[\s\S]*?\n\}/, '');
for (const m of withoutAutoLight.matchAll(/:root\[data-theme='([a-z]+)'\]\s*\{([\s\S]*?)\n\}/g)) {
  themeTokens[m[1]] = { ...baseTokens, ...tokensFrom(m[2]) };
}
const optionsHtmlSrc = readFileSync(join(root, 'src/options.html'), 'utf8');
const swatches = [...optionsHtmlSrc.matchAll(/<button class="theme" data-theme="([a-z]+)"><i style="([^"]+)"/g)];
if (!swatches.length) {
  console.log('  FAIL no theme swatches found in options.html');
  fail++;
}
for (const [, name, style] of swatches) {
  const declared = (prop) => {
    const m = style.match(new RegExp(prop + ':\\s*([^;]+)'));
    return m ? m[1].trim() : null;
  };
  const theme = themeTokens[name];
  if (!theme) {
    console.log(`  FAIL the ${name} swatch has no theme block to preview`);
    fail++;
    continue;
  }
  if (
    declared('--sw-bg') !== theme['--bg'] ||
    declared('--sw-accent') !== theme['--accent'] ||
    declared('--sw-line') !== theme['--line']
  ) {
    console.log(
      `  FAIL the ${name} swatch draws ${declared('--sw-bg')}/${declared('--sw-accent')}/${declared('--sw-line')} where the theme uses ${theme['--bg']}/${theme['--accent']}/${theme['--line']}`
    );
    fail++;
  }
  if (name === 'auto' && declared('--sw-bg2') !== autoLight['--bg']) {
    console.log(`  FAIL the auto swatch second colour is not the light page colour (${autoLight['--bg']})`);
    fail++;
  }
}
console.log(`  theme swatches: ${swatches.length} previews, each matching its own theme tokens`);

// A settings page has one label column: every row's text starts at the same x, and a note
// under a row lines up with the labels it explains. Four values in three places decide it,
// and changing any one of them alone breaks the column silently, so derive them.
const ruleBody = (sel) => {
  // Anchored to a line start: `label.pill` must not match the tail of
  // `body:not(.popup) label.pill`, which carries different values.
  const m = cssSrc.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
  return m ? m[1] : null;
};
const gapOf = (body) => {
  const m = body && body.match(/gap:\s*([\d.]+)px/);
  return m ? Number(m[1]) : null;
};
const borderLeftOf = (body) => {
  const direct = body && body.match(/border-left-width:\s*([\d.]+)px/);
  if (direct) return Number(direct[1]);
  const m = body && body.match(/border:\s*([\d.]+)px/);
  return m ? Number(m[1]) : 0;
};
const padLeftOf = (body) => {
  const direct = body && body.match(/padding-left:\s*([\d.]+)px/);
  if (direct) return Number(direct[1]);
  const m = body && body.match(/padding:\s*([^;]+);/);
  if (!m) return null;
  const v = m[1].trim().split(/\s+/).map(parseFloat);
  return v.length === 1 ? v[0] : v.length === 2 ? v[1] : v[3];
};
const radioRow = ruleBody('label.radio');
const switchRow = ruleBody('label.pill');
const controlBox = ruleBody("input[type='checkbox'],\ninput[type='radio']");
const noteRow = ruleBody('body:not(.popup) .card > .row.mini');
const controlWidth = controlBox && Number((controlBox.match(/width:\s*([\d.]+)px/) || [])[1]);
const column =
  borderLeftOf(radioRow) + padLeftOf(radioRow) + controlWidth + gapOf(radioRow);

if (gapOf(switchRow) !== gapOf(radioRow)) {
  console.log(
    `  FAIL the switch rows use a ${gapOf(switchRow)}px gap and the choice rows ${gapOf(radioRow)}px, so stacked rows sit out of line`
  );
  fail++;
} else {
  console.log(
    `  one control column: border ${borderLeftOf(radioRow)}px + pad ${padLeftOf(radioRow)}px + control ${controlWidth}px + gap ${gapOf(radioRow)}px = text at ${column}px`
  );
}
if (padLeftOf(noteRow) !== column) {
  console.log(
    `  FAIL a note under a row is indented ${padLeftOf(noteRow)}px where the label column is at ${column}px`
  );
  fail++;
} else {
  console.log(`  notes under a row line up with the labels: ${padLeftOf(noteRow)}px`);
}
// The dropdown's arrow is a layered background-image from the base select rule, so a
// later `background:` shorthand erases it silently and, with appearance:none in play,
// leaves a control that looks like plain text.
const selectRow = ruleBody('select');
const langRow = ruleBody('.lang-select');
if (!selectRow || !/background-image/.test(selectRow)) {
  console.log('  FAIL the base select rule no longer draws a chevron');
  fail++;
}
if (langRow && /(^|[;\s])background\s*:/.test(langRow)) {
  console.log('  FAIL .lang-select sets the background shorthand, which erases the dropdown arrow');
  fail++;
}
if (!langRow || (!/background-image/.test(langRow) && !/background-image/.test(selectRow))) {
  console.log('  FAIL the language picker has no arrow of its own and no chevron to inherit');
  fail++;
}
// The status line's mode labels were English literals in the page script, so a Polish page
// read "Aktywne: wiping on visit" and nothing failed: no key was missing, the phrase simply
// never went through the bundle. A phrase a page prints has to come from t(); the only
// acceptable literal is the English fallback on the same line as the t() call.
for (const file of ['src/options.js', 'src/popup.js']) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  for (const phrase of ['wiping on visit', 'wiping at browser start', 'wiping at browser close']) {
    for (const line of lines) {
      if (line.trim().startsWith('//')) continue;   // a comment may name the phrase
      if (line.includes(phrase) && !line.includes("t('")) {
        console.log(`  FAIL ${file} prints the English phrase "${phrase}" without going through t()`);
        fail++;
      }
    }
  }
}
console.log('  no English phrase is printed straight out of a page script');

// The extension tells the user, in the app and in the policy, that nothing they type
// into it goes anywhere the browser would upload. That is a property of the code, so
// it gets a guard: the shipped files may not write to the synced area. The single
// exception is the migration in store.js that adopts a list an older build left there
// and removes it, and that exception is allowed only inside that one function.
{
  const storeSource = readFileSync(join(root, 'src/store.js'), 'utf8');
  const adoptStart = storeSource.indexOf('async function adoptLegacyRules');
  const adoptEnd = storeSource.indexOf('\n}', adoptStart);
  const adoptBody = adoptStart > -1 ? storeSource.slice(adoptStart, adoptEnd) : '';
  const outsideAdoption = storeSource.slice(0, adoptStart) + storeSource.slice(adoptEnd);
  let bad = 0;
  if (!adoptBody) {
    console.log('  FAIL adoptLegacyRules is gone from store.js, so this guard checks nothing');
    bad++;
  }
  if (/chrome\.storage\.sync|areaSet\(['"]sync['"]/.test(outsideAdoption)) {
    console.log('  FAIL store.js writes to the synced area outside the one-time adoption');
    bad++;
  }
  for (const file of ['src/options.js', 'src/popup.js', 'src/service-worker.js', 'src/i18n.js', 'src/matcher.js', 'src/lock.js', 'src/confirm-gate.js']) {
    if (readFileSync(join(root, file), 'utf8').includes('storage.sync')) {
      console.log(`  FAIL ${file} touches the synced area`);
      bad++;
    }
  }
  if (!bad) console.log('  nothing is written to the synced area except the one-time adoption');
  fail += bad;
}

if (!/class="row sep"/.test(optionsHtmlSrc)) {
  console.log('  FAIL no .row.sep in the markup, so the choosing rows and the on/off rows run together');
  fail++;
} else {
  console.log('  choosing rows and on/off rows are separated by a rule, not by margin alone');
}

console.log(fail === 0 ? '\npages: ok' : `\npages: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
