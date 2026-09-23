// What a page needs has to be inside the package.
//
// Every other check in this project reads the working tree, which is why a package can be
// missing a file the pages import and still look fine from here. It is not fine: the
// browser refuses the module, the script never runs, and the page keeps its first-paint
// text ("Loading") with no listener on any control.
//
// That is not hypothetical. src/logtext.js was added with the log rewrite and never added
// to the packager's file list, so from 1.6.0 to 1.7.4 every build shipped a popup and a
// settings page that could not load, and every test here stayed green because they all
// tested the tree it came from.
//
//   ->  node tests/package.test.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
let skipped = 0;

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

/** The packager's file list, read out of the packager so the two cannot drift. */
function packagedFiles() {
  const source = readFileSync('tools/package.py', 'utf8');
  const block = source.match(/FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('tools/package.py has no FILES list this test can read');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every relative import in a script, with multi-line import blocks handled. */
function relativeImports(source) {
  const out = [];
  for (const m of source.matchAll(/import\s+[\s\S]*?from\s+['"](\.[^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

const path = (parts) => parts.join('/').replace(/\/\.\//g, '/');
const dir = (name) => name.split('/').slice(0, -1).join('/');

function resolve(from, spec) {
  const base = dir(from);
  const parts = (base ? base.split('/') : []).concat(spec.split('/'));
  const stack = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

const list = packagedFiles();

check('the packager lists files at all', () => {
  if (list.length < 10) throw new Error(`only ${list.length} entries`);
});

check('every file the package imports is in the package', () => {
  const have = new Set(list);
  const missing = [];
  for (const name of list) {
    if (!name.endsWith('.js') || !existsSync(name)) continue;
    for (const spec of relativeImports(readFileSync(name, 'utf8'))) {
      const target = resolve(name, spec);
      if (!have.has(target)) missing.push(`${name} imports ${spec} (${target}), which is not listed`);
    }
  }
  if (missing.length) throw new Error(missing.join('; '));
});

check('every listed file exists on disk', () => {
  const gone = list.filter((name) => !existsSync(name));
  if (gone.length) throw new Error(`listed but not on disk: ${gone.join(', ')}`);
});

// The zips are gitignored, so a clean checkout has none and the artifact check has
// nothing to judge. Say that out loud rather than reporting a pass.
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

const zips = existsSync('builds')
  ? readdirSync('builds')
      .filter((n) => /^lil-bro-.*wipe-.*\.zip$/.test(n))
      .sort((a, b) =>
        compareVersions(a.match(/(\d+\.\d+\.\d+)\.zip$/)[1], b.match(/(\d+\.\d+\.\d+)\.zip$/)[1])
      )
  : [];
const newestZip = zips[zips.length - 1];

// Built without src/logtext.js in the package, so their popup and settings page could not
// load. Named one by one rather than as "everything before the fix", so every other zip is
// actually checked here and a future build cannot inherit the exemption by being old.
const BUILT_WITHOUT_LOGTEXT = ['1.6.0', '1.6.1', '1.7.0', '1.7.1', '1.7.2', '1.7.3', '1.7.4'];

check('the exempted builds are still exactly the ones that shipped without the module', () => {
  if (BUILT_WITHOUT_LOGTEXT.join(',') !== '1.6.0,1.6.1,1.7.0,1.7.1,1.7.2,1.7.3,1.7.4') {
    throw new Error(`the exempted list changed: ${BUILT_WITHOUT_LOGTEXT.join(', ')}`);
  }
});

// A file that joined the package after the newest zip was built. The build that introduces
// it is the next one, so the zip already shipped is not held to it, and the version that
// carries it is named here so this cannot grow into a general "missing files are fine".
const ADDED_IN = { 'src/bmc.png': '1.8.0' };

const cmpVersion = (a, b) => {
  const [x, y, z] = a.split('.').map(Number);
  const [p, q, r] = b.split('.').map(Number);
  return x - p || y - q || z - r;
};

check('the files added after a build shipped are named one at a time', () => {
  const entries = Object.entries(ADDED_IN).map(([name, v]) => `${name}@${v}`);
  if (entries.join(',') !== 'src/bmc.png@1.8.0') {
    throw new Error(`the added-file list changed: ${entries.join(', ')}`);
  }
});

if (!zips.length) {
  skipped++;
  console.log('  skip  every zip carries what its pages import (no zips on this checkout)');
} else {
  const { execFileSync } = await import('node:child_process');
  for (const zip of zips) {
    const version = zip.match(/(\d+\.\d+\.\d+)\.zip$/)[1];
    if (BUILT_WITHOUT_LOGTEXT.includes(version)) {
      skipped++;
      console.log(`  skip  ${zip} carries what its pages import (shipped without src/logtext.js)`);
      continue;
    }
    check(`${zip} carries what its pages import`, () => {
      // The list of names inside the archive, without unpacking it.
      const listing = execFileSync('unzip', ['-Z1', `builds/${zip}`], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const have = new Set(listing);
      const problems = [];
      for (const name of listing) {
        if (!name.endsWith('.js')) continue;
        const source = execFileSync('unzip', ['-p', `builds/${zip}`, name], { encoding: 'utf8' });
        for (const spec of relativeImports(source)) {
          const target = resolve(name, spec);
          if (!have.has(target)) problems.push(`${name} imports ${spec}, which the zip does not carry`);
        }
      }
      // Only the newest zip is judged against today's file list. An older one was packed
      // from the list as it stood then, and holding it to a later list reports a change as
      // a defect: every build before 1.6.0 is "missing" a file that did not exist yet.
      if (zip === newestZip) {
        const unlisted = list.filter(
          (name) => !have.has(name) && !(ADDED_IN[name] && cmpVersion(ADDED_IN[name], version) > 0)
        );
        if (unlisted.length) problems.push(`missing from the zip: ${unlisted.join(', ')}`);
      }
      if (problems.length) throw new Error(problems.join('; '));
    });
  }
}

console.log(`\npackage: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
