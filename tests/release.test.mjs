// What has to line up before a version counts as released.
//
// Five places carry a version number: the manifest, the zip in builds/, the row in
// docs/VERSIONS.md, the section in CHANGELOG.md and the release tag on GitHub.
// They are kept in step by hand, which is exactly why this test exists: the rule
// already broke once, when three different builds all called themselves 1.3.0.
//
// A version sitting in the manifest with no zip yet is normal development and this
// test says nothing about it. What it refuses is a built zip that nothing
// documents, a zip whose bytes no longer match the hash written next to it, and a
// table that has fallen behind the code.
//   ->  node tests/release.test.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

// The oldest section in CHANGELOG.md. Zips older than this are covered by the note
// at the bottom of that file instead of a section each, which is the one exemption
// this test grants.
const CHANGELOG_STARTS_AT = '1.2.0';

const manifest = JSON.parse(read('manifest.json'));
const versions = read('docs/VERSIONS.md');
const changelog = read('CHANGELOG.md');

// | 1.5.3 | 20 Sep | `abc1234` | `230b1e58885e90bd` | note |
const rows = versions
  .split('\n')
  .filter((l) => /^\|\s*\d+\.\d+\.\d+\s*\|/.test(l))
  .map((l) => {
    const cells = l.split('|').map((c) => c.trim());
    return { version: cells[1], built: cells[2], commit: cells[3], sha: cells[4], note: cells[5] };
  });

const changelogVersions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);

const zips = readdirSync(root + 'builds')
  .filter((f) => /^lil-bro-(history-)?wipe-\d+\.\d+\.\d+\.zip$/.test(f))
  .map((f) => ({
    file: f,
    version: f.replace(/^lil-bro-(history-)?wipe-/, '').replace(/\.zip$/, ''),
  }));

const age = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [age(a), age(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
};

console.log('versions, built artifacts and the documents that describe them');

check('the table parses, and every row has a version and a hash', () => {
  if (rows.length < 10) throw new Error(`only ${rows.length} rows parsed out of VERSIONS.md`);
  const broken = rows.filter((r) => !/^\d+\.\d+\.\d+$/.test(r.version) || !/^`[0-9a-f]{16}`$/.test(r.sha || ''));
  if (broken.length) throw new Error(`rows that do not fit the table: ${broken.map((r) => r.version).join(', ')}`);
});

check('no version appears twice in the table', () => {
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.version)) throw new Error(`${r.version} has two rows`);
    seen.add(r.version);
  }
});

check('every zip that exists has a row', () => {
  const missing = zips.filter((z) => !rows.some((r) => r.version === z.version));
  if (missing.length) {
    throw new Error(`built but undocumented: ${missing.map((z) => `${z.version} (${z.file})`).join(', ')}`);
  }
});

check('every zip still matches the hash written next to its version', () => {
  const wrong = [];
  for (const z of zips) {
    const row = rows.find((r) => r.version === z.version);
    if (!row) continue;
    const digest = createHash('sha256').update(readFileSync(root + 'builds/' + z.file)).digest('hex');
    if (!digest.startsWith(row.sha.replace(/`/g, ''))) {
      wrong.push(`${z.version}: table says ${row.sha}, the file is ${digest.slice(0, 16)}`);
    }
  }
  if (wrong.length) throw new Error(`a zip was rebuilt after its row was written: ${wrong.join('; ')}`);
});

check('every zip says on the inside what its file name says', () => {
  const wrong = [];
  for (const z of zips) {
    let inside = null;
    try {
      inside = execFileSync('python', ['-c', `import json,zipfile,sys;print(json.loads(zipfile.ZipFile(sys.argv[1]).read("manifest.json"))["version"])`, root + 'builds/' + z.file], { encoding: 'utf8' }).trim();
    } catch {
      wrong.push(`${z.version}: could not read its manifest`);
      continue;
    }
    if (inside !== z.version) wrong.push(`${z.file} holds ${inside}`);
  }
  if (wrong.length) throw new Error(`mislabelled zip: ${wrong.join('; ')}`);
});

check('every zip built since the changelog started has a section', () => {
  // The changelog's oldest section is 1.2.0 and the note under it covers everything
  // before that, so 1.1.1 is the only zip without a section of its own. A new build
  // is always newer than the floor, so it cannot hide behind this.
  const missing = zips.filter(
    (z) => !changelogVersions.includes(z.version) && !newer(CHANGELOG_STARTS_AT, z.version)
  );
  if (missing.length) {
    throw new Error(`no changelog entry for: ${missing.map((z) => z.version).join(', ')}`);
  }
});

check('the floor this test exempts is still the changelog it claims', () => {
  if (!changelogVersions.includes(CHANGELOG_STARTS_AT)) {
    throw new Error(
      `CHANGELOG.md no longer has a section for ${CHANGELOG_STARTS_AT}, so the exemption for ` +
        `older builds is stale and should be removed`
    );
  }
});

check('the newest zip is the newest table row and the newest changelog entry', () => {
  const newestZip = zips.map((z) => z.version).reduce((a, b) => (newer(a, b) ? a : b));
  const newestRow = rows.map((r) => r.version).reduce((a, b) => (newer(a, b) ? a : b));
  const newestEntry = changelogVersions.reduce((a, b) => (newer(a, b) ? a : b));
  if (newestZip !== newestRow) throw new Error(`newest zip ${newestZip}, newest row ${newestRow}`);
  if (newestZip !== newestEntry) throw new Error(`newest zip ${newestZip}, newest changelog ${newestEntry}`);
  // The manifest being ahead of the newest zip is ordinary: a bump happens before
  // the build. Being behind it is the failure, and the next check catches that.
});

check('the manifest is never behind the newest documented version', () => {
  const newestRow = rows.map((r) => r.version).reduce((a, b) => (newer(a, b) ? a : b));
  if (newer(newestRow, manifest.version)) {
    throw new Error(`the table documents ${newestRow}, the manifest is still ${manifest.version}`);
  }
});

check('the table names the same current version as the manifest', () => {
  const said = (versions.match(/The current code is numbered (\d+\.\d+\.\d+)\./) || [])[1];
  if (!said) throw new Error('the sentence naming the current version is gone from VERSIONS.md');
  if (said !== manifest.version) {
    throw new Error(`VERSIONS.md says ${said}, the manifest says ${manifest.version}`);
  }
});

console.log(`\nrelease: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
