// Lil Bro — History Wipe
// The matching engine. Pure functions, zero chrome.* usage, so it can be run
// under `node` directly in the test suite.

const WIPEABLE_SCHEME = /^(?:https?|ftp|file):/i;

export function isWipeableUrl(url) {
  return typeof url === 'string' && WIPEABLE_SCHEME.test(url);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
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
  return v.startsWith('www.') ? v.slice(4) : v;
}

function canonUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i, (m, s, h) => `${s.toLowerCase()}://${h.toLowerCase()}`);
}

export function hostMatches(host, domain, includeSubdomains) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  if (h === d) return true;
  return !!includeSubdomains && h.endsWith('.' + d);
}

export function urlMatches(url, ruleValue) {
  const u = canonUrl(url);
  const v = canonUrl(ruleValue);
  if (!u || !v) return false;
  if (u === v) return true;
  if (u === v + '/') return true;
  if (!u.startsWith(v)) return false;
  // Only treat it as a prefix match on a path/query boundary, so
  // "example.com/app" does not swallow "example.com/application".
  return /[/?#&=]/.test(u.charAt(v.length));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keywordMatches(text, keyword, wholeWord) {
  const t = String(text || '');
  const k = String(keyword || '');
  if (!t || !k) return false;
  const pattern = wholeWord
    ? `(^|[^\\p{L}\\p{N}_])${escapeRegExp(k)}([^\\p{L}\\p{N}_]|$)`
    : escapeRegExp(k);
  try {
    return new RegExp(pattern, 'iu').test(t);
  } catch {
    return false;
  }
}

function regexMatches(text, source) {
  try {
    return new RegExp(source, 'iu').test(String(text || ''));
  } catch {
    return false;
  }
}

/**
 * Does one history item match one rule?
 * item: { url, title }
 */
export function itemMatchesRule(item, rule) {
  if (!item || !rule || rule.enabled === false) return false;
  const url = item.url || '';
  const title = item.title || '';

  switch (rule.type) {
    case 'domain':
      return hostMatches(hostOf(url), rule.value, rule.includeSubdomains);
    case 'url':
      return urlMatches(url, rule.value);
    case 'keyword':
      return keywordMatches(url, rule.value, rule.wholeWord) || keywordMatches(title, rule.value, rule.wholeWord);
    case 'regex':
      return regexMatches(url, rule.value) || regexMatches(title, rule.value);
    default:
      return false;
  }
}

/** First matching rule wins. Returns the rule or null. */
export function findMatch(item, rules) {
  if (!isWipeableUrl(item && item.url)) return null;
  for (const rule of rules || []) {
    if (itemMatchesRule(item, rule)) return rule;
  }
  return null;
}
