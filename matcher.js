// Lil Bro: History Wipe
// The matching engine. Pure functions, zero chrome.* usage, so it can be run
// under `node` directly in the test suite.

const WIPEABLE_SCHEME = /^(?:https?|ftp|file):/i;

// A regex rule is written by the user but tested against text the visited page
// controls (its title, its URL), inside a worker Chrome kills after 30s idle.
// A pattern like (a+)+ costs 133ms on a 26-character title and roughly 4x more
// for every 2 characters after that, so both sides of the test are bounded.
export const REGEX_MAX_PATTERN = 200;
export const REGEX_MAX_TEXT = 300;

/**
 * True when a group that repeats is itself repeated: (a+)+, (a*)*, (\w+\s?)*.
 * That is the shape that backtracks exponentially. Plain alternation such as
 * (foo|bar)+ is linear and passes.
 */
export function hasNestedQuantifier(source) {
  return /\((?:\\.|[^()\\])*[*+](?:\\.|[^()\\])*\)\s*[*+{]/.test(String(source == null ? '' : source));
}

/** A pattern worth running at all: bounded length, no exponential backtracking. */
export function isRunnableRegex(source) {
  const src = String(source == null ? '' : source);
  return src.length > 0 && src.length <= REGEX_MAX_PATTERN && !hasNestedQuantifier(src);
}

// Patterns refused at match time, so a caller can explain why nothing was wiped.
const skippedPatterns = new Set();

export function skippedRegexes() {
  return [...skippedPatterns];
}

export function resetSkippedRegexes() {
  skippedPatterns.clear();
}


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
  const src = String(source == null ? '' : source);
  if (!isRunnableRegex(src)) {
    skippedPatterns.add(src.slice(0, 60));
    return false;
  }
  try {
    // Truncated: the tail of a very long title or URL is not worth a stalled sweep.
    return new RegExp(src, 'iu').test(String(text || '').slice(0, REGEX_MAX_TEXT));
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
