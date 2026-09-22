// The promises a user cannot check for themselves, checked here instead.
//
// The README, the store listing and the privacy page all say the same three things: it
// talks to nobody, it asks for nothing beyond a fixed list of permissions, and the one
// address it holds is the support page. A person installing an extension has no way to
// test any of that, which is exactly why it belongs in the suite: the day a fetch() or a
// host permission appears in a shipped file, this fails here instead of quietly making
// the listing untrue.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

const page = (p) => readFileSync(p, 'utf8');
const manifest = JSON.parse(page('manifest.json'));
const en = JSON.parse(page('_locales/en/messages.json'));
const pl = JSON.parse(page('_locales/pl/messages.json'));

const files = [];
for (const name of readdirSync('src')) {
  if (/\.(js|html)$/.test(name)) files.push(join('src', name));
}
const shipped = files.map((f) => ({ path: f, text: page(f) }));

check('no script in the package can make a request', () => {
  const calls = [];
  for (const f of shipped) {
    for (const m of f.text.matchAll(
      /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.sendBeacon)\s*[(.]/g
    )) {
      calls.push({ path: f.path, api: m[1], at: m.index });
    }
  }
  // Reading a file out of the package is the one allowed use of fetch, and it never
  // leaves the machine: chrome.runtime.getURL resolves inside the extension.
  const allowed = calls.filter((c) => c.api !== 'fetch');
  if (allowed.length) {
    throw new Error(`${allowed[0].path} calls ${allowed[0].api}`);
  }
  for (const c of calls) {
    const after = shipped.find((f) => f.path === c.path).text.slice(c.at, c.at + 40);
    if (!after.includes('chrome.runtime.getURL')) throw new Error(`${c.path}: ${after.trim()}`);
  }
});

check('the only real address in the package is the support page', () => {
  const hosts = new Set();
  for (const f of shipped) {
    for (const m of f.text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  }
  const unexpected = [...hosts].filter(
    (h) =>
      h !== 'buymeacoffee.com' &&
      h !== 'translate' && // the escaped remainder of the tester's example pattern
      !/(^|\.)example\.com$/.test(h)
  );
  if (unexpected.length) throw new Error(`found ${unexpected.join(', ')}`);
  // Both halves matter: the support link has to still be there, and the example.com
  // placeholders are the tester's, not somewhere the extension sends anything.
  if (!hosts.has('buymeacoffee.com')) throw new Error('the support link is gone');
  // translate.google.com is the tester's worked example of a pattern, text on a page, not
  // somewhere this thing goes. It is named here so that keeping the example is a decision
  // rather than an accident.
});

check('the permissions are exactly the ones the README lists', () => {
  const declared = new Set([...manifest.permissions, ...(manifest.optional_permissions || [])]);
  const readme = page('README.md').split('\n');
  // The sentence wraps across lines in the README, so read the whole paragraph.
  const from = readme.findIndex((l) => l.startsWith('Permissions:'));
  if (from < 0) throw new Error('the README no longer says what it asks for');
  let paragraph = '';
  for (let i = from; i < readme.length && readme[i].trim() !== ''; i += 1) paragraph += readme[i] + ' ';
  const listed = new Set([...paragraph.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]));
  const missing = [...listed].filter((p) => !declared.has(p));
  const extra = [...declared].filter((p) => !listed.has(p));
  if (missing.length || extra.length) {
    throw new Error(`README says ${[...missing].join(', ') || '-'}, manifest has ${[...extra].join(', ') || '-'}`);
  }
});

check('nothing is asked for that the listing does not name', () => {
  const forbidden = [
    'host_permissions',
    'content_scripts',
    'externally_connectable',
    'web_accessible_resources',
    'nativeMessaging',
    'declarativeNetRequest',
  ];
  const found = forbidden.filter((k) => manifest[k] || (manifest.permissions || []).includes(k));
  if (found.length) throw new Error(`the manifest declares ${found.join(', ')}`);
});

check('nothing in the package can be told to run code from outside it', () => {
  const csp = manifest.content_security_policy;
  const policy = csp && (csp.extension_pages || JSON.stringify(csp));
  if (policy && /unsafe-eval|unsafe-inline|http/.test(policy)) {
    throw new Error(`the policy allows ${policy}`);
  }
  for (const f of shipped) {
    if (/\beval\s*\(|new Function\s*\(/.test(f.text)) throw new Error(`${f.path} evaluates code`);
  }
});

check('every message key the manifest names exists in both bundles', () => {
  const named = [...page('manifest.json').matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)].map((m) => m[1]);
  for (const key of named) {
    if (!en[key]) throw new Error(`${key} is not in the English bundle`);
    if (!pl[key]) throw new Error(`${key} is not in the Polish bundle`);
  }
  // The keyboard shortcut's own description is one of these, so a shortcut added without
  // its wording lands here rather than as a blank entry in the browser's shortcut list.
  if (!named.includes('cmdWipeSite')) throw new Error('the shortcut has no description');
});

check('the rules for reading a file out of the package are the only ones', () => {
  const allow = new Set(['chrome.runtime.getURL']);
  for (const f of shipped) {
    for (const m of f.text.matchAll(/fetch\(\s*([^)]{0,40})/g)) {
      const what = m[1].trim();
      if (![...allow].some((a) => what.startsWith(a))) throw new Error(`${f.path}: fetch(${what}`);
    }
  }
});

console.log(`privacy: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
