// The store listing is copy, and copy is what a reviewer and a shopper read, so it gets
// checked against the package rather than trusted. Every rule here fired on something real:
// a justification for a permission the extension no longer asks for is a review rejection,
// a field over its character limit is a rejection too, and a claim about where data goes
// that the code contradicts is the defect nobody notices until a user does.
//
// CHANGELOG.md and docs/VERSIONS.md are deliberately not swept for the old claims: they
// record what past releases did, including the ones that did sync the list.
//   ->  node tests/listing.test.mjs
import { readFileSync, existsSync } from 'node:fs';

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

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (rel) => readFileSync(root + rel, 'utf8');
const readBytes = (rel) => readFileSync(root + rel);

const manifest = JSON.parse(read('manifest.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const paste = read('store-listing/dashboard-paste-en.txt');
const pastePl = read('store-listing/dashboard-paste-pl.txt');

// --- the fields, split out of the paste document ------------------------------
const HEADINGS = /^(?:PERMISSION: (\w+) \((\d+)\)|SINGLE PURPOSE \((\d+)\)|DESCRIPTION \((\d+)\)|TITLE \([^)]*\)|SUMMARY \([^)]*\)|CATEGORY|REMOTE CODE|DATA USAGE checkboxes|ADULT CONTENT|GOOGLE ANALYTICS \(GA4\)|PRIVACY POLICY URL|HELP URL|HOME PAGE \/ PRODUCT PAGE URL)$/gm;
const marks = [...paste.matchAll(HEADINGS)].map((m) => ({
  label: m[0],
  at: m.index,
  name: m[1] || null,
  limit: m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : m[4] ? Number(m[4]) : null,
}));
const fields = marks.map((mark, i) => {
  const until = i + 1 < marks.length ? marks[i + 1].at : paste.length;
  const body = paste
    .slice(mark.at + mark.label.length, until)
    .replace(/^-+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { ...mark, body };
});
const field = (label) => fields.find((f) => f.label === label);

console.log('the listing against the package');

check('the paste document has fields at all', () => {
  if (fields.length < 8) throw new Error(`only ${fields.length} field(s) parsed; the format moved`);
});

check('every permission in the manifest has a justification', () => {
  const missing = manifest.permissions.filter((p) => !field(`PERMISSION: ${p} (1000)`));
  if (missing.length) throw new Error(`no justification for: ${missing.join(', ')}`);
});

check('the optional permission is justified, and says it is optional', () => {
  for (const p of manifest.optional_permissions || []) {
    const f = field(`PERMISSION: ${p} (1000)`);
    if (!f) throw new Error(`no justification for the optional permission ${p}`);
    if (!/optional/i.test(f.body)) throw new Error(`${p} does not say it is optional`);
  }
});

check('no justification is written for a permission the extension does not ask for', () => {
  const asked = new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])]);
  const stray = fields.filter((f) => f.name && !asked.has(f.name)).map((f) => f.name);
  if (stray.length) throw new Error(`justified but not requested: ${stray.join(', ')}`);
});

check('every justified permission still appears in the permission list', () => {
  const stray = fields.filter((f) => f.name && !paste.includes(f.name));
  if (stray.length) throw new Error(`listed twice or oddly named: ${stray.map((f) => f.name).join(', ')}`);
});

check('each field fits the character limit in its own label', () => {
  const over = fields
    .filter((f) => f.limit && f.body.length > f.limit)
    .map((f) => `${f.label}: ${f.body.length} of ${f.limit}`);
  if (over.length) throw new Error(over.join('; '));
});

check('every field a person has to paste has something in it', () => {
  // Prose fields need a real sentence or two. The short-answer fields are allowed to be a
  // word: "No." is the whole of the adult-content answer.
  const PROSE = /^(PERMISSION:|SINGLE PURPOSE|DESCRIPTION)/;
  const empty = fields
    .filter((f) => (PROSE.test(f.label) ? f.body.length < 40 : f.body.length < 2))
    .map((f) => f.label);
  if (empty.length) throw new Error(`empty: ${empty.join(', ')}`);
});

check('the title in the paste is the name in the package', () => {
  const t = field('TITLE (from the package, fills itself on upload)');
  if (!t) throw new Error('no title field');
  if (t.body !== en.name.message) throw new Error(`paste says "${t.body}", the bundle says "${en.name.message}"`);
});

// --- the claims, across every surface that makes them -------------------------
const CLAIM_FILES = [
  'README.md',
  'docs/index.html',
  'docs/privacy.html',
  'store-listing/dashboard-paste-en.txt',
  'store-listing/dashboard-paste-pl.txt',
  'store-listing/dashboard-fields.md',
  'store-listing/dashboard-fields-pl.md',
  'store-listing/listing.md',
  'store-listing/privacy-policy.html',
  'store-listing/bmc-page.txt',
  'store-listing/README.md',
  '_locales/en/messages.json',
  '_locales/pl/messages.json',
];

// Each pattern is a sentence that was true of an older build and is not true now.
const FALSE_CLAIMS = [
  /synced extension storage/i,
  /sync between your computers/i,
  /travels? between your computers/i,
  /follows? (?:the user|you) to (?:their|your) other/i,
  /other signed-in devices/i,
  /browser's own sync/i,
];

check('no surface still claims the list syncs or follows you between machines', () => {
  const hits = [];
  for (const file of CLAIM_FILES) {
    if (!existsSync(root + file)) continue;
    const text = read(file);
    for (const pattern of FALSE_CLAIMS) {
      const m = text.match(pattern);
      if (m) hits.push(`${file}: "${m[0]}"`);
    }
  }
  if (hits.length) throw new Error(hits.join(' | '));
});

check('the listing and the hosted policy say the same thing about where the list lives', () => {
  const claim = 'is not put anywhere the browser would upload';
  for (const file of ['docs/privacy.html', 'store-listing/dashboard-paste-en.txt']) {
    const flat = read(file).replace(/\s+/g, ' ');
    if (!flat.includes(claim)) throw new Error(`${file} does not carry the claim`);
  }
});

check('the policy in the listing is the hosted policy, not an older copy', () => {
  const hosted = readBytes('docs/privacy.html');
  const copy = readBytes('store-listing/privacy-policy.html');
  if (!hosted.equals(copy)) {
    throw new Error('they differ, so a reviewer is reading something the public URL does not say');
  }
});

check('no field a person pastes pins a version number that will go stale', () => {
  // Only the things that get pasted into the dashboard, and only because a version named
  // there is wrong by the next release. listing.md keeps its history: it records which
  // build the packager used to produce, and that is a fact about the past.
  const hits = [];
  for (const file of [
    'store-listing/dashboard-paste-en.txt',
    'store-listing/dashboard-paste-pl.txt',
    'store-listing/dashboard-fields.md',
    'store-listing/dashboard-fields-pl.md',
  ]) {
    const m = read(file).match(/\b1\.\d+\.\d+\b/);
    if (m) hits.push(`${file}: ${m[0]}`);
  }
  if (hits.length) throw new Error(hits.join(' | '));
});

console.log(`\nlisting: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
