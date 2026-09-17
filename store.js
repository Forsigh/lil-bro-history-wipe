// Lil Bro — History Wipe
// Shared state helpers. Used by the service worker and every extension page.

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
  // rules. History only — cookies, cache and site data stay untouched.
  wipeAllHistory: false,
};

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
    if (raw.length < 4) warning = 'Short keywords can match unrelated pages — check the tester below.';
    if (/\s/.test(raw) && raw.split(/\s+/).length > 4) warning = 'Long keyword phrases rarely match. A single word usually works better.';
    rule.wholeWord = !!wholeWord;
  } else if (type === 'regex') {
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

export async function getState() {
  const raw = await chrome.storage.local.get([
    'rules',
    'settings',
    'pending',
    'log',
    'stats',
  ]);
  return {
    rules: Array.isArray(raw.rules) ? raw.rules : [],
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

export async function saveState(patch) {
  await chrome.storage.local.set(patch);
}

export function activeRules(rules) {
  return (rules || []).filter((r) => r && r.enabled !== false);
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
