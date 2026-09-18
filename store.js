// Lil Bro: History Wipe
// Shared state helpers. Used by the service worker and every extension page.

import { hasNestedQuantifier, REGEX_MAX_PATTERN } from './matcher.js';

export const DEFAULT_SETTINGS = {
  enabled: true,
  // 'realtime' = wipe the moment you visit; 'onclose' = wipe when the browser
  // closes (best effort) and guaranteed at next start; 'startup' = wipe at the
  // start of every browser session.
  mode: 'realtime',
  // Also run a full scan of existing history at browser start, so entries that
  // were already in history before a rule existed still get cleaned.
  sweepExistingOnStartup: true,
  notifyOnWipe: true,
  logEnabled: true,
  logLimit: 200,
  // Remembers the "include subdomains" tick in the popup for next time.
  includeSubdomainsDefault: false,
  // DANGER: when true, every trigger erases the whole history instead of matching
  // rules. History only, cookies, cache and site data stay untouched.
  wipeAllHistory: false,
  // 'block' (default): wipe what matches a rule. 'allow': the rules become a keep
  // list and everything else is wiped. Off by default, because the second one
  // deletes far more than the user typed in.
  listMode: 'block',
  // Optional PIN lock over the pages. Off by default. Only the salted hash of the
  // PIN is kept, and the lock is per-device, so it never syncs.
  lockEnabled: false,
  lockHash: '',
  lockSalt: '',
  lockIterations: 0,
  // The clear presets: cache, download history, saved form text, cookies.
  extraCache: false,
  extraCookies: false,
  extraDownloads: false,
  extraFormData: false,
  // How far back a clear reaches: 'hour' | 'day' | 'week' | 'month' | 'all'.
  extraSince: 'day',
  // 'manual': the buttons only. 'triggers': also when the browser closes and when
  // the next session starts. Never on a visit: erasing cookies as you browse is
  // not a cleaner.
  extraTrigger: 'manual',
  // The toolbar popup opens compact. 'classic' brings back the older, denser one.
  popupLayout: 'simple',
  advanced: false,
  // One name for a mix of the four extra switches. The flags stay the truth.
  preset: 'off',
  // Domains that keep their cookies when a cookie clear runs.
  cookieKeep: [],
  cookiesOnStart: false,
  cookiesOnTabClose: false,
  // auto | light | dark | neon | paper | slate
  theme: 'auto',
};

/**
 * The extra kinds, in the order they are offered. Anything not in here is not
 * something this extension claims to erase.
 */
export const EXTRA_LABELS = {
  cache: 'Cache',
  cookies: 'Cookies and site data',
  downloads: 'Download history',
  formData: 'Saved form text',
};

export const EXTRA_SINCE_LABELS = {
  hour: 'the last hour',
  day: 'the last day',
  week: 'the last week',
  month: 'the last month',
  all: 'everything, however old',
};

/** True when at least one extra kind is switched on. */
export function extraOn(settings) {
  return !!(
    settings &&
    (settings.extraCache || settings.extraCookies || settings.extraDownloads || settings.extraFormData)
  );
}

/** The extra kinds that are on, in the order they are offered. */
export function extraKinds(settings) {
  const out = [];
  if (!settings) return out;
  if (settings.extraCache) out.push('cache');
  if (settings.extraCookies) out.push('cookies');
  if (settings.extraDownloads) out.push('downloads');
  if (settings.extraFormData) out.push('formData');
  return out;
}

export function describeExtras(settings) {
  const kinds = extraKinds(settings);
  return kinds.length ? kinds.map((k) => EXTRA_LABELS[k]).join(', ') : '';
}

/** The three mixes, plus off. Custom is what the switches say when none fit. */
export const PRESETS = {
  off: { extras: { cache: false, cookies: false, downloads: false, formData: false }, wipeAll: false },
  light: { extras: { cache: true, cookies: false, downloads: false, formData: false }, wipeAll: false },
  standard: { extras: { cache: true, cookies: true, downloads: false, formData: true }, wipeAll: false },
  nuclear: { extras: { cache: true, cookies: true, downloads: true, formData: true }, wipeAll: true },
};

/** The settings a preset stands for. */
export function presetPatch(name) {
  const p = PRESETS[name];
  if (!p) return null;
  return {
    preset: name,
    extraCache: p.extras.cache,
    extraCookies: p.extras.cookies,
    extraDownloads: p.extras.downloads,
    extraFormData: p.extras.formData,
    wipeAllHistory: p.wipeAll,
  };
}

/** Which preset the switches add up to, or 'custom'. */
export function presetName(settings) {
  for (const [name, p] of Object.entries(PRESETS)) {
    const same =
      !!settings.extraCache === p.extras.cache &&
      !!settings.extraCookies === p.extras.cookies &&
      !!settings.extraDownloads === p.extras.downloads &&
      !!settings.extraFormData === p.extras.formData &&
      !!settings.wipeAllHistory === p.wipeAll;
    if (same) return name;
  }
  return 'custom';
}

/** One domain per line, as typed. */
export function parseCookieKeep(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const d = line
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^\./, '')
      .replace(/\/.*$/, '');
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * The DataTypeSet for chrome.browsingData.remove(), or null when nothing is on.
 * Cookies drag the rest of a site's storage along: clearing the cookie and
 * leaving localStorage and IndexedDB behind is the half-cleaned state that
 * makes a browser look broken.
 *
 * No passwords, ever. Chrome removed password deletion from this API in Chrome
 * 144 and the call has had no effect since, so offering it would be a lie.
 * Flash and WebSQL are gone from Chrome as well.
 */
export function extraSelection(settings) {
  if (!extraOn(settings)) return null;
  const withCookies = !!settings.extraCookies;
  return {
    cache: !!settings.extraCache,
    cookies: withCookies,
    downloads: !!settings.extraDownloads,
    formData: !!settings.extraFormData,
    localStorage: withCookies,
    indexedDB: withCookies,
    cacheStorage: withCookies,
    serviceWorkers: withCookies,
    fileSystems: withCookies,
  };
}

/** The `since` timestamp for a clear, or 0 for "everything, however old". */
export function extraSinceMs(settings, now = Date.now()) {
  const spans = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
  const ms = spans[settings && settings.extraSince];
  return ms ? now - ms : 0;
}

export const RULE_TYPES = {
  domain: 'Site / domain',
  url: 'URL or URL prefix',
  keyword: 'Keyword in URL or title',
  regex: 'Regular expression',
};

export const MODE_LABELS = {
  realtime: 'Instantly, as I browse',
  onclose: 'When I close the browser',
  startup: 'When I start the browser',
};

export const SCHEMA_VERSION = 1;

export function newId() {
  return 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function normalizeDomain(value) {
  let v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return '';
  if (v.includes('://')) {
    try {
      v = new URL(v).hostname;
    } catch {
      v = v.split('://')[1] || '';
    }
  }
  v = v.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  v = v.replace(/^\.+/, '').replace(/\.+$/, '');
  if (v.startsWith('www.')) v = v.slice(4);
  return v;
}

function canonUrlForRule(value) {
  return String(value || '').trim().replace(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i, (m, s, h) => `${s.toLowerCase()}://${h.toLowerCase()}`);
}

/**
 * Validate + normalize a rule before it is stored.
 * Returns { ok: true, rule } or { ok: false, error, warning? }
 */
export function buildRule({ type, value, includeSubdomains = false, wholeWord = false } = {}) {
  if (!RULE_TYPES[type]) return { ok: false, error: 'Unknown rule type.' };
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: false, error: 'Enter a value first.' };

  let warning = '';
  const rule = {
    id: newId(),
    type,
    value: raw,
    includeSubdomains: false,
    wholeWord: false,
    enabled: true,
    createdAt: Date.now(),
  };

  if (type === 'domain') {
    const d = normalizeDomain(raw);
    if (!d || !/^[a-z0-9.-]+$/.test(d)) return { ok: false, error: 'That does not look like a domain (example.com).' };
    if (!d.includes('.') && d !== 'localhost') return { ok: false, error: 'Use a full domain, e.g. example.com' };
    rule.value = d;
    rule.includeSubdomains = !!includeSubdomains;
  } else if (type === 'url') {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { ok: false, error: 'Start the URL with http:// or https://' };
    }
    rule.value = canonUrlForRule(raw);
  } else if (type === 'keyword') {
    if (raw.length < 2) return { ok: false, error: 'Keywords need at least 2 characters.' };
    if (raw.length < 4) warning = 'Short keywords can match unrelated pages. Check the tester below.';
    if (/\s/.test(raw) && raw.split(/\s+/).length > 4) warning = 'Long keyword phrases rarely match. A single word usually works better.';
    rule.wholeWord = !!wholeWord;
  } else if (type === 'regex') {
    if (raw.length > REGEX_MAX_PATTERN) {
      return { ok: false, error: `Regular expressions are capped at ${REGEX_MAX_PATTERN} characters.` };
    }
    if (hasNestedQuantifier(raw)) {
      return {
        ok: false,
        error:
          'A group that repeats inside another repeated group makes the browser crawl on long page titles. ' +
          'Write (ab)+ instead of (ab+)+, or use a keyword rule.',
      };
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(raw, 'iu');
    } catch (e) {
      return { ok: false, error: `Invalid regular expression: ${e.message}` };
    }
    rule.value = raw;
  }

  return warning ? { ok: true, rule, warning } : { ok: true, rule };
}

export function mergeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// --- where the rules live ---------------------------------------------------
// Rules go to chrome.storage.sync so the same list follows the user to their
// other computers, with a local mirror as the fallback. Settings stay local on
// purpose: the whole-history switch and the keep list are per-device decisions,
// and a danger switch that syncs itself is a trap.

export const RULES_MIRROR_KEY = 'rulesMirror';
export const RULES_META_KEY = 'rulesMeta';
export const RULES_CHUNK_PREFIX = 'rulesChunk';
const SYNC_CHUNK_CHARS = 6000; // sync allows 8 KB per item
const SYNC_MAX_CHUNKS = 16; // ~96 KB of the 100 KB budget, leaving room for the rest

async function areaGet(area, keys) {
  try {
    const res = await chrome.storage[area].get(keys);
    return res && typeof res === 'object' ? res : {};
  } catch {
    return null; // a switched-off or full sync must not break wiping
  }
}

async function areaSet(area, patch) {
  try {
    await chrome.storage[area].set(patch);
    return true;
  } catch {
    return false;
  }
}

async function areaRemove(area, keys) {
  try {
    if (keys.length) await chrome.storage[area].remove(keys);
    return true;
  } catch {
    return false;
  }
}

/** Split the list so no single sync item goes over its 8 KB cap. */
export function chunkRules(rules) {
  const chunks = [];
  let current = [];
  let size = 2; // the array brackets
  for (const rule of rules) {
    const cost = JSON.stringify(rule).length + 1;
    if (current.length && size + cost > SYNC_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(rule);
    size += cost;
  }
  chunks.push(current);
  return chunks.slice(0, SYNC_MAX_CHUNKS);
}

const chunkKeys = (n) => Array.from({ length: n }, (_, i) => RULES_CHUNK_PREFIX + i);

/**
 * The rule list: from sync when it answers, from the local mirror otherwise. A
 * list that only exists locally (written before rules synced, or on a browser
 * with sync switched off) is copied up on the first read.
 */
export async function readRules() {
  const metaBag = (await areaGet('sync', RULES_META_KEY)) || {};
  const info = metaBag[RULES_META_KEY];
  const declared = info && Number.isInteger(info.chunks) ? info.chunks : 0;

  if (declared > 0) {
    const bag = (await areaGet('sync', chunkKeys(declared))) || {};
    const out = [];
    for (let i = 0; i < declared; i++) {
      const part = bag[RULES_CHUNK_PREFIX + i];
      if (Array.isArray(part)) out.push(...part);
    }
    // A declared-but-empty list means the user deleted every rule.
    if (out.length || (info.count === 0 && Object.keys(bag).length)) return out;
  }

  const local = (await areaGet('local', ['rules', RULES_MIRROR_KEY])) || {};
  const fallback = Array.isArray(local.rules)
    ? local.rules
    : Array.isArray(local[RULES_MIRROR_KEY])
      ? local[RULES_MIRROR_KEY]
      : [];
  if (Array.isArray(local.rules) || fallback.length) await writeRules(fallback);
  return fallback;
}

/** Write the list to sync (chunked) and to the local mirror. */
export async function writeRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const chunks = chunkRules(list);
  const payload = {
    [RULES_META_KEY]: { chunks: chunks.length, count: list.length, at: Date.now() },
  };
  chunks.forEach((chunk, i) => {
    payload[RULES_CHUNK_PREFIX + i] = chunk;
  });

  const before = (await areaGet('sync', RULES_META_KEY)) || {};
  const had = before[RULES_META_KEY] && Number.isInteger(before[RULES_META_KEY].chunks) ? before[RULES_META_KEY].chunks : 0;

  const synced = await areaSet('sync', payload);
  if (synced && had > chunks.length) await areaRemove('sync', chunkKeys(had).slice(chunks.length));

  await areaSet('local', { [RULES_MIRROR_KEY]: list, rules: list });
  return synced;
}

export async function getState() {
  const raw = (await areaGet('local', ['settings', 'pending', 'log', 'stats'])) || {};
  return {
    rules: await readRules(),
    settings: mergeSettings(raw.settings),
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    log: Array.isArray(raw.log) ? raw.log : [],
    stats: {
      wipedTotal: 0,
      lastRunAt: 0,
      lastRunCount: 0,
      lastRunPhase: '',
      ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}),
    },
  };
}

/** Rules are split off to sync; everything else stays local. */
export async function saveState(patch) {
  const { rules, ...rest } = patch || {};
  if (Object.keys(rest).length) await areaSet('local', rest);
  if (rules !== undefined) await writeRules(rules);
}

/**
 * The last resort behind the recovery word: rules, settings, log, queue and stats,
 * on this device and in sync. Used by the forgot-the-PIN path, and the only caller.
 */
export async function factoryReset() {
  await writeRules([]); // empty the list, and let the emptiness reach the other devices
  await areaRemove('local', ['settings', 'pending', 'log', 'stats', 'rules', 'rulesMirror']);
  await areaSet('local', { settings: { ...DEFAULT_SETTINGS } });
  await areaRemove('session', ['pinFails', 'pinLastFailAt', 'bootHandled']);
  return true;
}

// --- PIN lock throttle -------------------------------------------------------
// Kept in session storage, so closing and reopening a page does not hand out a
// fresh set of tries. Cleared when the browser restarts.

export async function readAttempts() {
  try {
    const raw = await chrome.storage.session.get(['pinFails', 'pinLastFailAt']);
    return { fails: Number(raw.pinFails) || 0, lastFailAt: Number(raw.pinLastFailAt) || 0 };
  } catch {
    return { fails: 0, lastFailAt: 0 };
  }
}

export async function writeAttempts(fails, lastFailAt) {
  try {
    await chrome.storage.session.set({
      pinFails: Number(fails) || 0,
      pinLastFailAt: Number(lastFailAt) || 0,
    });
  } catch {
    // best effort: the lock still works, it just forgets the count
  }
}

export function activeRules(rules) {
  return (rules || []).filter((r) => r && r.enabled !== false);
}

/** True when the rules are a keep list rather than a wipe list. */
export function isKeepMode(settings) {
  return !!settings && settings.listMode === 'allow';
}

export function describeRule(rule) {
  if (!rule) return 'unknown rule';
  switch (rule.type) {
    case 'domain':
      return rule.includeSubdomains ? `${rule.value} + subdomains` : rule.value;
    case 'url':
      return rule.value;
    case 'keyword':
      return `keyword "${rule.value}"`;
    case 'regex':
      return `/${rule.value}/`;
    default:
      return String(rule.value || '');
  }
}

export function describeMode(settings) {
  if (!settings.enabled) return 'Paused';
  return MODE_LABELS[settings.mode] || settings.mode;
}
