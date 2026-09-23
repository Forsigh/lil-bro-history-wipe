// Lil Bro: everything a person reads comes out of the locale
//
// A sentence typed straight into a page script is English in every language, because
// nothing looks it up. That is how a Polish screen ended up with English status lines
// while every bundle key was present. This walks the scripts that draw text, pulls out
// their string literals with a real tokeniser, and fails on any sentence-like one that
// is not the fallback of a t() lookup.
//
// A literal is a fallback when the code before it, with all the strings blanked out,
// is nothing but punctuation since the last || : that is the shape used throughout,
// t('someKey') || 'English', which only shows when a locale lacks the key. Strings
// inside strings are not tokens at all, so a quoted phrase inside a fallback is fine.
//
// The allowlist is for text that is not language: setting values, status kinds, brand
// names, formats and technical tokens.
//
//   node tests/english.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The scripts that put text in front of a person.
const FILES = [
  'src/options.js',
  'src/popup.js',
  'src/service-worker.js',
  'src/store.js',
  'src/lock.js',
  'src/confirm-gate.js',
  'src/matcher.js',
  'src/logtext.js',
];

// Not language.
const ALLOWED = [
  /^Lil Bro/,            // the name
  /^PIN/,
  /^Chrome/,
  /^lilbro$/,
  /^WIPE ALL$/,
  /^FULL$/,
  /^(On|Off|Auto|Manual)$/,
];

// Setting values, status kinds, hosts, paths, media types, regex fragments, formats.
const NOT_LANGUAGE = [
  /^[a-z][a-z0-9_-]*$/,
  /^[a-z][a-z0-9_.:/?#[\]@!$&'()*+,;=%-]*$/i,
  /^[A-Z][a-z]+$/,                        // single capitalised words, checked against ALLOWED
  /^[^A-Za-z]*$/,                         // punctuation and numbers only
  /[\\^$*+?()[\]{}|]/,                    // anything that looks like a pattern
  /^[a-z-]+$/,
];

/** Walk the source: literals as tokens, everything else blanked so || can be spotted. */
function tokenise(src) {
  const lits = [];
  let blanked = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        blanked += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) blanked += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < src.length) {
        if (src[j] === '\\') {
          text += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        text += src[j];
        j++;
      }
      lits.push({ start: i, text });
      for (; i < j + 1 && i < src.length; i++) blanked += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    blanked += c;
    i++;
  }
  return { lits, blanked };
}

/** Fallback shape: since the last || there is nothing but punctuation in the code. */
function isFallback(blanked, start) {
  const code = blanked.slice(0, start);
  const bar = code.lastIndexOf('||');
  if (bar === -1) return false;
  const tail = code.slice(bar + 2);
  if (!/^[\s+()?:,[\]]*$/.test(tail)) return false;
  const statement = code.slice(Math.max(code.lastIndexOf(';'), code.lastIndexOf('{')));
  return /\bt\(\s*$|\bt\(/.test(statement);
}

const READS_AS_PROSE = [
  /[A-Z][a-z]+ [a-z]/,        // two words with a capital starts it
  /[A-Za-z]{4}[\u2026.]$/,    // a word ending as a sentence: "Clearing…", "Wiped."
  /^[A-Z][^a-z]*[a-z]+ .*[a-z]/,
];

/** Console and thrown-by-programmer strings never reach a screen. */
function isDeveloper(blanked, start) {
  const code = blanked.slice(0, start);
  return /(\blog\(|new Error\()\s*$/.test(code);
}

let fail = 0;
let walked = 0;
let developer = 0;

for (const file of FILES) {
  const src = readFileSync(join(root, file), 'utf8');
  const { lits, blanked } = tokenise(src);
  for (const lit of lits) {
    const text = lit.text;
    if (!/[A-Za-z]{2}/.test(text)) continue;
    if (ALLOWED.some((re) => re.test(text))) continue;
    if (NOT_LANGUAGE.some((re) => re.test(text))) continue;
    if (!READS_AS_PROSE.some((re) => re.test(text))) continue;
    if (isDeveloper(blanked, lit.start)) {
      developer++;
      continue;
    }
    walked++;
    if (isFallback(blanked, lit.start)) continue;
    const line = blanked.slice(0, lit.start).split('\n').length;
    console.log(`  FAIL ${file}:${line} is English in every language: "${text.slice(0, 64)}"`);
    fail++;
  }
}

console.log(
  `  english: ${walked} lines a person could read, ${fail} of them without a locale (${developer} console-only, skipped)`
);
console.log(fail === 0 ? 'english: ok' : `english: ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
