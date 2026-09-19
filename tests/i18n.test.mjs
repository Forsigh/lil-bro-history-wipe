// Every key the UI asks for must exist in every locale, otherwise a label falls
// back to English. Also checks the manifest placeholders, which Chrome resolves
// before the extension even loads: a missing one there breaks the install.
//
//   node tests/i18n.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readLocale = (l) => JSON.parse(readFileSync(join(root, '_locales', l, 'messages.json'), 'utf8'));
const locales = readdirSync(join(root, '_locales'));
const en = readLocale('en');

let fail = 0;
const used = new Set();

for (const page of ['src/popup.html', 'src/options.html']) {
  const html = readFileSync(join(root, page), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
}
for (const js of ['src/popup.js', 'src/options.js']) {
  const src = readFileSync(join(root, js), 'utf8');
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) used.add(m[1]);
}

for (const key of [...used].sort()) {
  if (!en[key] || !en[key].message) {
    console.log(`  FAIL "${key}" is asked for by the UI but missing from _locales/en`);
    fail++;
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
  if (!en[m[1]] || !en[m[1]].message) {
    console.log(`  FAIL manifest placeholder __MSG_${m[1]}__ has no message`);
    fail++;
  }
  used.add(m[1]);
}

for (const l of locales) {
  if (l === 'en') continue;
  const other = readLocale(l);
  const missing = Object.keys(en).filter((k) => !other[k] || !other[k].message);
  if (missing.length) {
    console.log(`  FAIL ${l} is missing ${missing.length} key(s): ${missing.slice(0, 6).join(', ')}`);
    fail++;
  }
}

console.log(`  i18n: ${used.size} keys in use, ${Object.keys(en).length} in en, locales [${locales.join(', ')}]`);
console.log(fail === 0 ? 'i18n: ok' : `i18n: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
