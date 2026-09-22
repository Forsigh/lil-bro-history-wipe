// Lil Bro Wipe: History Cleaner
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

/**
 * Which of the item's two texts the rule landed in, and where in it. Kept honest by
 * itemMatchesRule, which is asked first, so this can never disagree with it about
 * whether something matched, only about where.
 */
function whereIn(url, title, rule) {
  const value = rule.value;
  if (rule.type === 'keyword') {
    const inUrl = keywordAt(url, value, rule.wholeWord);
    if (inUrl) return { field: 'url', word: value, at: inUrl.at };
    const inTitle = keywordAt(title, value, rule.wholeWord);
    if (inTitle) return { field: 'title', word: value, at: inTitle.at };
    return { field: 'url', word: value, at: null };
  }
  if (rule.type === 'regex') {
    const inUrl = regexAt(url, value);
    if (inUrl) return { field: 'url', word: inUrl.word, at: inUrl.at };
    const inTitle = regexAt(title, value);
    if (inTitle) return { field: 'title', word: inTitle.word, at: inTitle.at };
    return { field: 'url', word: value, at: null };
  }
  // A site rule and an address rule cover the whole address, so there is no one
  // spot inside it that made them match.
  return { field: 'url', word: value, at: null };
}

function keywordAt(text, keyword, wholeWord) {
  const t = String(text || '');
  const k = String(keyword || '');
  if (!t || !k) return null;
  const pattern = wholeWord
    ? `(^|[^\\p{L}\\p{N}_])${escapeRegExp(k)}([^\\p{L}\\p{N}_]|$)`
    : escapeRegExp(k);
  try {
    const m = new RegExp(pattern, 'iu').exec(t);
    if (!m) return null;
    // With the boundary groups in play the word starts after group 1.
    return { at: m.index + (wholeWord ? (m[1] || '').length : 0) };
  } catch {
    return null;
  }
}

function regexAt(text, source) {
  const src = String(source == null ? '' : source);
  if (!isRunnableRegex(src)) return null;
  try {
    const m = new RegExp(src, 'iu').exec(String(text || '').slice(0, REGEX_MAX_TEXT));
    if (!m) return null;
    return { at: m.index, word: m[0] || src };
  } catch {
    return null;
  }
}

/**
 * The text around a match, cut to something a person can take in at a glance.
 * Addresses are routinely two kilobytes of token, and the word that matched sits
 * somewhere inside with nothing to say where, so the log shows the neighbourhood.
 */
export function excerptAround(text, at, word, span = 26) {
  const t = String(text || '');
  if (!t) return '';
  const len = String(word || '').length;
  const start = at == null ? 0 : Math.max(0, at - span);
  const end = at == null ? Math.min(t.length, span * 2) : Math.min(t.length, at + len + span);
  let cut = t.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) cut = `…${cut}`;
  if (end < t.length) cut = `${cut}…`;
  return cut;
}

/**
 * Exempt first, always. A rule marked "never delete" wins over every wipe rule, no
 * matter what order the list is in and no matter how many wipe rules also match on
 * the same page. An exemption is a promise, and a promise that depends on the order
 * of a list is not one.
 *
 * Returns { rule, field, word, at } for the rule that keeps the page, or null.
 */
export function explainExempt(item, rules) {
  if (!isWipeableUrl(item && item.url)) return null;
  const url = String((item && item.url) || '');
  const title = String((item && item.title) || '');
  for (const rule of rules || []) {
    if (!rule || rule.exempt !== true || rule.enabled === false) continue;
    if (!itemMatchesRule(item, rule)) continue;
    return { rule, ...whereIn(url, title, rule) };
  }
  return null;
}

/** The rule that keeps the page off the wipe list, or null. */
export function findExempt(item, rules) {
  const hit = explainExempt(item, rules);
  return hit ? hit.rule : null;
}

/**
 * The first wipe rule that matches, with the detail the log needs to explain itself.
 * A page an exemption covers never gets here at all.
 * Returns { rule, field, word, at } or null.
 */
export function explainMatch(item, rules) {
  if (explainExempt(item, rules)) return null;
  if (!isWipeableUrl(item && item.url)) return null;
  const url = String((item && item.url) || '');
  const title = String((item && item.title) || '');
  for (const rule of rules || []) {
    if (!itemMatchesRule(item, rule)) continue;
    return { rule, ...whereIn(url, title, rule) };
  }
  return null;
}

/** First matching rule wins. Returns the rule or null. */
export function findMatch(item, rules) {
  const hit = explainMatch(item, rules);
  return hit ? hit.rule : null;
}

/**
 * What a person visits a lot and no rule covers: the suggestion side of the product.
 * The same matcher decides what would be wiped, so a site that shows up here is one
 * the current list really does not touch, and a site that would be wiped never shows
 * up however busy it is.
 *
 * Rules that are switched off do not cover anything, so their sites stay visible.
 * Entries are what the history read returns; the visit count comes from the entry when
 * the browser reports one, otherwise every entry counts once.
 */
export function rankUncovered(entries, rules, limit = 10) {
  const active = (rules || []).filter((rule) => rule && rule.enabled !== false);
  const byHost = new Map();
  for (const item of entries || []) {
    const url = String((item && item.url) || '');
    if (!isWipeableUrl(url)) continue;
    const host = hostOf(url);
    if (!host) continue;
    if (findExempt(item, active) || findMatch(item, active)) continue;
    const visits = Number(item.visitCount) > 0 ? Number(item.visitCount) : 1;
    const last = Number(item.lastVisitTime) || 0;
    const seen = byHost.get(host);
    if (seen) {
      seen.visits += visits;
      seen.last = Math.max(seen.last, last);
    } else {
      byHost.set(host, { host, visits, last });
    }
  }
  return [...byHost.values()]
    .sort((a, b) => b.visits - a.visits || b.last - a.last)
    .slice(0, limit);
}
