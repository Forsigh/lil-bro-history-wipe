// Lil Bro Wipe: History Cleaner
// Service worker. The only place that deletes anything.

import { explainMatch, explainExempt, excerptAround, isWipeableUrl, rankUncovered } from './matcher.js';
import { t, setLang, currentLang } from './i18n.js';
import {
  getState,
  saveState,
  activeRules,
  describeRule,
  buildRule,
  normalizeDomain,
  isKeepMode,
  extraOn,
  extraSelection,
  extraSinceMs,
  describeExtras,
} from './store.js';

const SWEEP_TIME_BUDGET_MS = 4 * 60 * 1000; // stay well inside the 5 min per-request cap
const SWEEP_PAGE_SIZE = 1000;
const DELETE_CHUNK = 25;
const PENDING_CAP = 5000;
const PREVIEW_SAMPLE = 25;
// The suggestion read: on request only, bounded in pages and in time, nothing stored.
const INSIGHT_PAGES = 4;
const INSIGHT_PAGE_SIZE = 1000;
const INSIGHT_BUDGET_MS = 5000;
const INSIGHT_LIMIT = 8;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log('[Lil Bro]', ...args);
}

/**
 * Visits can arrive several at a time, and every state write is a
 * read-modify-write. Without serialising them, concurrent visits clobber each
 * other's pending/log entries. Never call a locked helper from another locked
 * helper.
 */
let stateLock = Promise.resolve();
function withLock(fn) {
  const run = stateLock.then(fn, fn);
  stateLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function pushLog(entries) {
  if (!entries.length) return;
  return withLock(async () => {
    const { settings, log: existing } = await getState();
    if (!settings.logEnabled) return;
    const merged = [...entries, ...existing].slice(0, Math.max(1, settings.logLimit));
    await saveState({ log: merged });
  });
}

async function bumpStats(count, phase) {
  return withLock(async () => {
    const { stats } = await getState();
    await saveState({
      stats: {
        ...stats,
        wipedTotal: (stats.wipedTotal || 0) + count,
        lastRunAt: Date.now(),
        lastRunCount: count,
        lastRunPhase: phase,
      },
    });
  });
}

/** What each rule has removed, as a running total. Entries for rules that are gone are
 *  dropped here rather than by a separate sweep, so deleting a rule cannot leave its
 *  number behind on the page. */
async function bumpRuleCounts(hits) {
  if (!hits || !Object.keys(hits).length) return;
  return withLock(async () => {
    const { stats, rules } = await getState();
    const live = new Set((rules || []).map((r) => r.id));
    const byRule = {};
    for (const [id, n] of Object.entries(stats.byRule || {})) {
      if (live.has(id)) byRule[id] = n;
    }
    for (const [id, n] of Object.entries(hits)) {
      if (live.has(id)) byRule[id] = (byRule[id] || 0) + n;
    }
    await saveState({ stats: { ...stats, byRule } });
  });
}

/** The count as a word, in the plural form the language asks for: Polish has three, and
 *  "2 wpisów" reads as wrong to anyone who speaks it. English is the fallback, for the one
 *  case where the bundle has not loaded and the message still has to say something true. */
function countText(count) {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

function countWord(count) {
  let form = 'entryMany';
  try {
    const picked = new Intl.PluralRules(currentLang()).select(count);
    if (picked === 'one') form = 'entryOne';
    else if (picked === 'few') form = 'entryFew';
  } catch (e) {
    return countText(count);
  }
  return t(form, [String(count)]) || countText(count);
}

/** The one place a notification is raised, so the wording is decided by the caller. */
async function tell(message) {
  if (!message) return;
  const { settings } = await getState();
  if (!settings.notifyOnWipe) return;
  try {
    await chrome.notifications.create('lilbro-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
      title: 'Lil Bro',
      message,
    });
  } catch (e) {
    log('notification failed', e);
  }
}

async function notify(count) {
  if (!count) return;
  await tell(t('notifyWiped', [countWord(count)]) || `Wiped ${countWord(count)} from history.`);
}

/** A wipe aimed at one site can name it, unless the PIN is on: then the count is all it says. */
async function notifySite(site, count) {
  if (!count) return;
  const { settings } = await getState();
  const message = settings.lockEnabled
    ? t('notifyWiped', [countWord(count)]) || `Wiped ${countWord(count)} from history.`
    : t('notifyWipedSite', [countWord(count), site]) || `Wiped ${countWord(count)} for ${site}.`;
  await tell(message);
}

// ---------------------------------------------------------------------------
// the extra clear: cookies, cache, download history, saved form text
// ---------------------------------------------------------------------------

/** The one call site for chrome.browsingData. Only a button or an opted-in trigger. */
async function clearExtra(phase) {
  const { settings } = await getState();
  await useLang();
  const selection = extraSelection(settings);
  if (!selection) return { ok: false, error: t('errNoExtrasOn') || 'No extra data is switched on.' };
  if (!chrome.browsingData || typeof chrome.browsingData.remove !== 'function') {
    return {
      ok: false,
      error: t('errNoBrowsingData') || 'This browser build gives the extension no access to browsing data.',
    };
  }

  const since = extraSinceMs(settings);
  const kinds = describeExtras(settings);
  const started = Date.now();
  try {
    await chrome.browsingData.remove(since ? { since } : {}, selection);
  } catch (e) {
    log('browsingData.remove failed', e);
    return {
      ok: false,
      error: t('errClearRefused', [e && e.message ? e.message : String(e)]) || 'Chrome refused the clear: ' + (e && e.message ? e.message : e),
    };
  }

  await pushLog([
    { url: '(extra data)', title: kinds, rule: 'extra clear', why: 'extras', at: Date.now(), phase },
  ]);
  return { ok: true, kinds, since: settings.extraSince, took: Date.now() - started };
}

/** Whether an extra clear belongs at this trigger. Manual means exactly that. */
function extraAllowedAt(settings, phase) {
  if (!extraOn(settings)) return false;
  if (phase === 'manual') return true;
  return settings.extraTrigger === 'triggers';
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

/** True when the keep list says this host keeps its cookies. */
function cookieKept(settings, host) {
  const h = String(host || '').toLowerCase().replace(/^\./, '');
  if (!h) return false;
  return (settings.cookieKeep || []).some((raw) => {
    const d = String(raw || '').toLowerCase().trim().replace(/^\./, '');
    return !!d && (h === d || h.endsWith('.' + d));
  });
}

function cookieUrl(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  const path = c.path && c.path.startsWith('/') ? c.path : '/';
  return `${c.secure ? 'https' : 'http'}://${host}${path}`;
}

/** Every cookie for one host, unless that host is on the keep list. */
async function clearCookiesFor(host, settings) {
  await useLang();
  if (!chrome.cookies) return { ok: false, removed: 0, error: t('errNoCookies') || 'No cookie access.' };
  if (cookieKept(settings, host)) return { ok: true, removed: 0, kept: true };
  let removed = 0;
  for (const c of await chrome.cookies.getAll({ domain: host })) {
    try {
      await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
      removed++;
    } catch (e) {
      log('cookie remove failed', e);
    }
  }
  return { ok: true, removed };
}

/** Everything except the keep list. Used by the start trigger and the button. */
async function pruneCookies(settings) {
  await useLang();
  if (!chrome.cookies) return { ok: false, removed: 0, error: t('errNoCookies') || 'No cookie access.' };
  let removed = 0;
  for (const c of await chrome.cookies.getAll({})) {
    if (cookieKept(settings, c.domain)) continue;
    try {
      await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
      removed++;
    } catch (e) {
      log('cookie remove failed', e);
    }
  }
  return { ok: true, removed };
}

// Tab host tracking, so a closed tab's cookies can go with it. The url field
// needs the tabs permission, which is optional and asked for only when this is
// switched on. The map lives in session storage rather than in memory: the worker
// is stopped and started at will, and an in-memory map would be empty by the time
// a tab closes.
const TAB_MAP_KEY = 'tabHosts';

async function readTabHosts() {
  try {
    const got = await chrome.storage.session.get(TAB_MAP_KEY);
    return got[TAB_MAP_KEY] || {};
  } catch {
    return {};
  }
}

async function writeTabHosts(map) {
  try {
    await chrome.storage.session.set({ [TAB_MAP_KEY]: map });
  } catch {
    // session storage is best effort
  }
}

async function rememberTabHost(tab) {
  if (!tab || typeof tab.id !== 'number' || !tab.url) return;
  let host;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    host = u.hostname;
  } catch {
    return; // not a web page
  }
  const map = await readTabHosts();
  map[tab.id] = host;
  await writeTabHosts(map);
}

/** Takes the host off the map, so a repeated close cannot clear twice. */
async function forgetTabHost(tabId) {
  const map = await readTabHosts();
  const host = map[tabId];
  if (!host) return '';
  delete map[tabId];
  await writeTabHosts(map);
  return host;
}

async function tabsAllowed() {
  try {
    return !!(chrome.permissions && (await chrome.permissions.contains({ permissions: ['tabs'] })));
  } catch {
    return false;
  }
}

async function seedTabHosts() {
  if (!chrome.tabs || !(await tabsAllowed())) return;
  try {
    for (const tab of await chrome.tabs.query({})) rememberTabHost(tab);
  } catch (e) {
    log('tab seed failed', e);
  }
}

async function onTabClosed(tabId) {
  const host = await forgetTabHost(tabId);
  if (!host) return;
  const { settings } = await getState();
  if (!settings.cookiesOnTabClose) return;
  const res = await clearCookiesFor(host, settings);
  if (res.removed) {
    await pushLog([
      {
        url: host,
        title: `${res.removed} cookie${res.removed === 1 ? '' : 's'} cleared`,
        rule: 'cookie keep list',
        why: 'cookies',
        at: Date.now(),
        phase: 'tab close',
      },
    ]);
  }
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.url || info.status === 'complete') rememberTabHost(tab);
  });
  chrome.tabs.onRemoved.addListener((id) => {
    onTabClosed(id).catch((e) => log('tab close failed', e));
  });
}

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    seedTabHosts().catch(() => {});
  });
}

/**
 * The worker writes wording of its own: the two right-click entries, the notifications,
 * and the errors the pages show word for word. It has no page to apply a locale to, so it
 * loads the language itself, and each of those sites asks for the message it needs.
 */
async function useLang() {
  try {
    const { settings } = await getState();
    await setLang(settings.lang);
  } catch {
    // An unreadable store leaves the English fallback in place, which is the safe way round.
  }
}

async function ensureMenus() {
  try {
    await useLang();
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'lb-add-domain',
      title: t('menuWipeSite') || 'Lil Bro: wipe this site from history',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'lb-add-url',
      title: t('menuWipePage') || 'Lil Bro: wipe this exact page',
      contexts: ['page', 'link'],
    });
  } catch (e) {
    log('menu setup failed', e);
  }
}

// The titles live in the browser's own menu until they are replaced, so a language
// change has to rebuild them: without this the menu stays in the old language.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const before = changes.settings.oldValue && changes.settings.oldValue.lang;
    const after = changes.settings.newValue && changes.settings.newValue.lang;
    if (before !== after) ensureMenus().catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/** Log label for an entry removed because it was not on the keep list. */
const KEEP_LIST_RULE = { type: 'domain', value: 'not on your keep list', includeSubdomains: false };

/**
 * The one place that decides whether an entry gets wiped, for all three modes.
 * 'block' (the default): wipe it when a rule matches.
 * 'allow': the rules are a keep list, so wipe it when nothing matches.
 * An empty keep list wipes nothing, because inverting an empty list would empty
 * the database and the user would have asked for the opposite.
 * Returns the rule to record in the log, or null to leave the entry alone.
 */
function decideWipe(item, live, allow) {
  if (!isWipeableUrl(item && item.url)) return null;
  const hit = explainMatch(item, live);
  if (!allow) return hit;
  if (!live.length || hit) return null;
  // Keep mode wipes what is not on the list, so there is no rule and no word that
  // did it: the reason is the absence itself.
  return { rule: KEEP_LIST_RULE, field: 'url', word: '', at: null };
}

/**
 * The reason in the shape the log displays it: a code the pages translate, the word
 * or value that was involved, and, when the match was somewhere inside an address,
 * the bit of it around the match. An address is often two kilobytes of token with
 * the matching letters in the middle, and nobody can read that.
 */
function describeWhy(url, title, hit) {
  if (!hit) return { why: '', word: '', excerpt: '' };
  const field = hit.field === 'title' ? 'title' : 'url';
  const word = String(hit.word || '');
  let code;
  if (hit.rule === KEEP_LIST_RULE) code = 'keep-list';
  else if (hit.rule && hit.rule.type === 'keyword') code = `word-${field}`;
  else if (hit.rule && hit.rule.type === 'regex') code = `pattern-${field}`;
  else if (hit.rule && hit.rule.type === 'domain') code = 'site';
  else code = 'address';
  const excerpt = field === 'url' && hit.at != null ? excerptAround(url, hit.at, word) : '';
  return { why: code, word, excerpt };
}

/**
 * Delete already-matched items. targets: [{ url, title, hit?, rule?, why? }]
 * Returns the number actually deleted.
 */
async function wipeTargets(targets, phase) {
  let deleted = 0;
  const logEntries = [];
  const byRule = {};

  for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
    const chunk = targets.slice(i, i + DELETE_CHUNK);
    for (const t of chunk) {
      try {
        // deleteUrl needs the URL exactly as history.search() returned it.
        await chrome.history.deleteUrl({ url: t.url });
        deleted++;
        const ruleObj = t.hit ? t.hit.rule : t.rule;
        if (ruleObj && ruleObj.id) byRule[ruleObj.id] = (byRule[ruleObj.id] || 0) + 1;
        const why = t.why
          ? { why: t.why, word: t.word || '', excerpt: t.excerpt || '' }
          : describeWhy(t.url, t.title || '', t.hit);
        // A target from the live paths carries the rule object; one from the queue
        // carries the sentence that was already written for it.
        const ruleText = typeof t.rule === 'string' ? t.rule : describeRule(t.hit ? t.hit.rule : t.rule);
        logEntries.push({
          url: t.url,
          title: t.title || '',
          rule: ruleText,
          why: why.why,
          word: why.word,
          excerpt: why.excerpt,
          at: Date.now(),
          phase,
        });
      } catch (e) {
        log('deleteUrl failed', t.url, e);
      }
    }
  }

  await pushLog(logEntries);
  await bumpRuleCounts(byRule);
  return deleted;
}

/**
 * Full scan of the local history database, newest first, paginated by
 * lastVisitTime. Deletes everything decideWipe() selects, unless dryRun, in which
 * case it only reports what it found.
 */
async function sweepHistory(rules, phase, { budgetMs = SWEEP_TIME_BUDGET_MS, dryRun = false, allow = false } = {}) {
  // In keep mode an empty list means nothing is kept, so an empty rule set must
  // stop here rather than wipe the database.
  if (!rules.length) return { scanned: 0, deleted: 0, matched: 0, sample: [] };

  const started = Date.now();
  const seen = new Set();
  let endTime = Date.now() + 60 * 1000; // small future pad for clock skew
  let scanned = 0;
  let deleted = 0;
  let matched = 0;
  const sample = [];

  for (;;) {
    if (Date.now() - started > budgetMs) {
      log('sweep hit its time budget; remaining entries will be handled next run');
      break;
    }

    let batch;
    try {
      batch = await chrome.history.search({
        text: '',
        startTime: 0, // NOTE: an omitted startTime defaults to the last 24h, so it must be explicit
        endTime,
        maxResults: SWEEP_PAGE_SIZE,
      });
    } catch (e) {
      log('history.search failed', e);
      break;
    }

    if (!batch || batch.length === 0) break;

    let oldest = null;
    const targets = [];

    for (const item of batch) {
      if (!item || !item.url) continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      scanned++;
      const t = item.lastVisitTime || 0;
      if (t && (oldest === null || t < oldest)) oldest = t;
      if (!isWipeableUrl(item.url)) continue;
      const hit = decideWipe(item, rules, allow);
      if (!hit) continue;
      matched++;
      if (sample.length < PREVIEW_SAMPLE) {
        sample.push({
          url: item.url,
          title: item.title || '',
          rule: describeRule(hit.rule),
          ...describeWhy(item.url, item.title || '', hit),
        });
      }
      targets.push({ url: item.url, title: item.title || '', hit });
    }

    if (!dryRun) deleted += await wipeTargets(targets, phase);

    if (oldest === null || oldest <= 1) break;
    if (oldest >= endTime) break; // no progress, so stop instead of looping
    endTime = oldest - 1;
  }

  return { scanned, deleted, matched, sample };
}

// ---------------------------------------------------------------------------
// whole-history wipe (opt-in, history only)
// ---------------------------------------------------------------------------

/** Label used in the log for entries removed by the whole-history wipe. */
const WIPE_ALL_RULE = { type: 'domain', value: 'wipe all history', includeSubdomains: false };

/** Count every entry in the database, so the UI can report an honest number. */
async function countHistory(budgetMs = SWEEP_TIME_BUDGET_MS) {
  const started = Date.now();
  let endTime = Date.now() + 60 * 1000;
  let count = 0;

  for (;;) {
    if (Date.now() - started > budgetMs) break;
    let batch;
    try {
      batch = await chrome.history.search({
        text: '',
        startTime: 0,
        endTime,
        maxResults: SWEEP_PAGE_SIZE,
      });
    } catch (e) {
      log('count search failed', e);
      break;
    }
    if (!batch || batch.length === 0) break;

    let oldest = null;
    for (const item of batch) {
      if (!item || !item.url) continue;
      count++;
      const t = item.lastVisitTime || 0;
      if (t && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest === null || oldest <= 1 || oldest >= endTime) break;
    endTime = oldest - 1;
  }

  return count;
}

/** The rules that mean never delete, switched on. An exemption is a promise, so the
 *  paths that do not go through the matcher ask this first. */
async function activeKeeps() {
  const { rules } = await getState();
  return (rules || []).filter((rule) => rule && rule.exempt === true && rule.enabled !== false);
}

/**
 * Erase the entire history database. Only reachable when the user has switched on
 * the "wipe all history" toggle, never from the rule engine.
 *
 * With a never-delete rule in the list, "everything" cannot mean "including the sites
 * you told it not to touch", and one blanket erase cannot tell one site from another.
 * So it walks the URLs the same way the rules do instead of dropping the promise.
 */
async function wipeEverything(phase) {
  const kept = await activeKeeps();
  if (kept.length) {
    const all = await chrome.history.search({ text: '', startTime: 0, maxResults: 0 });
    let deleted = 0;
    for (const item of all) {
      if (!isWipeableUrl(item.url)) continue;
      if (explainExempt(item, kept)) continue;
      try {
        await chrome.history.deleteUrl({ url: item.url });
        deleted += 1;
      } catch (e) {
        log('deleteUrl failed', item.url, e);
      }
    }
    await pushLog([
      {
        url: '(entire history, except sites you never delete)',
        title: '',
        rule: 'wipe all history',
        why: 'wipe-all-except',
        at: Date.now(),
        phase,
      },
    ]);
    await withLock(async () => saveState({ pending: [] }));
    return { deleted };
  }

  const counted = await countHistory();
  try {
    await chrome.history.deleteAll();
  } catch (e) {
    log('deleteAll failed', e);
    return { deleted: 0 };
  }
  await pushLog([
    { url: '(entire history)', title: '', rule: 'wipe all history', why: 'wipe-all', at: Date.now(), phase },
  ]);
  await withLock(async () => saveState({ pending: [] }));
  return { deleted: counted };
}

// ---------------------------------------------------------------------------
// deferred queue (used by "when I close" / "when I start")
// ---------------------------------------------------------------------------

async function queuePending(item, hit) {
  return withLock(async () => {
    const { pending } = await getState();
    if (pending.length >= PENDING_CAP) return;
    if (pending.some((p) => p.url === item.url)) return;
    pending.push({
      url: item.url,
      title: item.title || '',
      rule: describeRule(hit && hit.rule ? hit.rule : hit),
      // Kept so the log row can still say what happened and where, hours later.
      ...describeWhy(item.url, item.title || '', hit),
      at: Date.now(),
    });
    await saveState({ pending });
  });
}

async function flushPending(phase) {
  const { pending } = await getState();
  if (!pending.length) return 0;
  const targets = pending.map((p) => ({
    url: p.url,
    title: p.title,
    rule: p.rule,
    why: p.why,
    word: p.word,
    excerpt: p.excerpt,
  }));
  const deleted = await wipeTargets(targets, phase);

  // Drop only what this run handled, so anything queued mid-flush survives.
  const handled = new Set(pending.map((p) => p.url));
  await withLock(async () => {
    const fresh = (await getState()).pending;
    await saveState({ pending: fresh.filter((p) => !handled.has(p.url)) });
  });
  return deleted;
}

// ---------------------------------------------------------------------------
// the session-start run. The reliable hook for both deferred modes
// ---------------------------------------------------------------------------

let startupInFlight = false;

async function runSessionStart(phase = 'startup') {
  if (startupInFlight) return { deleted: 0, skipped: true };
  startupInFlight = true;
  try {
    const { settings, rules } = await getState();
    if (!settings.enabled) return { deleted: 0, disabled: true };

    // Whole-history mode short-circuits the rule engine entirely.
    if (settings.wipeAllHistory) {
      // Deferred modes wipe at their trigger. Instant mode only wipes what is
      // already in history when the deep-scan box is ticked; otherwise it just
      // erases each new visit as it happens.
      const shouldWipeAtBoot = settings.mode !== 'realtime' || settings.sweepExistingOnStartup;
      const wiped = shouldWipeAtBoot ? (await wipeEverything(phase)).deleted : 0;
      await bumpStats(wiped, phase);
      await notify(wiped);
      const extra = extraAllowedAt(settings, phase) ? await clearExtra(phase) : null;
      const cookies = settings.cookiesOnStart ? await pruneCookies(settings) : null;
      return { deleted: wiped, wipeAll: true, skipped: !shouldWipeAtBoot, extra, cookies };
    }

    const live = activeRules(rules);
    let deleted = 0;

    // 1. Always flush whatever the previous session queued up.
    if (settings.mode === 'onclose' || settings.mode === 'startup') {
      deleted += await flushPending(phase);
    }

    // 2. Optional deep scan (catches entries that predate the rules).
    if (settings.sweepExistingOnStartup && live.length) {
      const res = await sweepHistory(live, phase, { allow: isKeepMode(settings) });
      deleted += res.deleted;
    }

    await bumpStats(deleted, phase);
    await notify(deleted);
    const extra = extraAllowedAt(settings, phase) ? await clearExtra(phase) : null;
    const cookies = settings.cookiesOnStart ? await pruneCookies(settings) : null;
    return { deleted, extra, cookies };
  } finally {
    startupInFlight = false;
    // Tab hosts are needed the moment a tab closes, and the worker is not always
    // running by then, so they go into session storage on every pass.
    seedTabHosts().catch(() => {});
  }
}

/**
 * chrome.storage.session is wiped when the browser restarts, so it doubles as
 * a "did we already handle this browser session" flag. Using it means the
 * startup work still runs when onStartup does not fire (fresh install, an
 * extension that was just enabled, a restored profile).
 */
async function bootOnce() {
  try {
    const flag = await chrome.storage.session.get('bootHandled');
    if (flag && flag.bootHandled) return;
    await chrome.storage.session.set({ bootHandled: true });
  } catch (e) {
    log('session flag unavailable', e);
  }
  await runSessionStart('startup');
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

async function handleVisit(item) {
  const { settings, rules } = await getState();
  if (!settings.enabled) return;
  if (!isWipeableUrl(item && item.url)) return;

  // Whole-history mode ignores rules: in instant mode nothing is ever recorded,
  // in the deferred modes the database is emptied at the trigger instead.
  if (settings.wipeAllHistory) {
    if (settings.mode !== 'realtime') return;
    const deleted = await wipeTargets(
      [{ url: item.url, title: item.title || '', rule: WIPE_ALL_RULE, why: 'wipe-all' }],
      'realtime'
    );
    if (deleted) await bumpStats(deleted, 'realtime');
    return;
  }

  const live = activeRules(rules);
  const hit = decideWipe(item, live, isKeepMode(settings));
  if (!hit) return;

  if (settings.mode === 'realtime') {
    const deleted = await wipeTargets(
      [{ url: item.url, title: item.title || '', hit }],
      'realtime'
    );
    if (deleted) await bumpStats(deleted, 'realtime');
    return;
  }

  await queuePending(item, hit);
}

chrome.history.onVisited.addListener((item) => {
  handleVisit(item).catch((e) => log('handleVisit failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  seedTabHosts().catch(() => {});
  runSessionStart('startup').catch((e) => log('startup run failed', e));
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureMenus().catch(() => {});
  if (details.reason === 'install' || details.reason === 'update') {
    bootOnce().catch((e) => log('boot run failed', e));
  }
});

/**
 * The context menu can add a rule without ever opening the extension's own pages,
 * which would be an editing route around the PIN lock. It says so instead of
 * quietly changing the list.
 */
async function notifyLockedMenu() {
  try {
    await useLang();
    await chrome.notifications.create('lilbro-lock-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
      title: 'Lil Bro',
      message:
        t('notifyLocked') ||
        'The PIN lock is on, so the list was left alone. Unlock it in the popup to add a site.',
    });
  } catch (e) {
    log('notification failed', e);
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.pageUrl || '';
  const { settings, rules } = await getState();

  if (settings.lockEnabled) {
    await notifyLockedMenu();
    return;
  }

  const candidate =
    info.menuItemId === 'lb-add-url'
      ? buildRule({ type: 'url', value: url })
      : buildRule({ type: 'domain', value: normalizeDomain(url), includeSubdomains: false });

  if (!candidate.ok) {
    log('context menu rule rejected', candidate.error);
    return;
  }
  rules.push(candidate.rule);
  await saveState({ rules });
  log('rule added from context menu:', describeRule(candidate.rule));
});

// The keyboard shortcut: wipe the site you are looking at, now, without opening anything.
// A command counts as a gesture, so the popup does not have to be open for it to work.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'wipe-site') return;
    const res = await wipeSiteNow(await activeTabUrl());
    if (!res.ok) log('shortcut did nothing:', res.error);
  });
}

/** Shared by the popup and options page: "Wipe now" and the read-only preview. */
async function manualRun(dryRun) {
  const { settings, rules } = await getState();
  await useLang();
  if (!settings.enabled) return { ok: false, error: t('notifyPaused') || 'Lil Bro is paused.' };

  // The extra clear rides along with a manual wipe when it is switched on and the
  // user asked for it here. A preview never clears anything.
  const clearExtraToo = !dryRun && extraAllowedAt(settings, 'manual');

  if (settings.wipeAllHistory) {
    if (dryRun) {
      const counted = await countHistory();
      return {
        ok: true,
        dryRun: true,
        wipeAll: true,
        scanned: counted,
        deleted: 0,
        matched: counted,
        sample: [],
        extra: null,
      };
    }
    const res = await wipeEverything('manual');
    await bumpStats(res.deleted, 'manual');
    return {
      ok: true,
      dryRun: false,
      wipeAll: true,
      scanned: res.deleted,
      deleted: res.deleted,
      matched: res.deleted,
      sample: [],
      extra: clearExtraToo ? await clearExtra('manual') : null,
    };
  }

  const live = activeRules(rules);
  const allow = isKeepMode(settings);
  if (!live.length) {
    return {
      ok: false,
      error: allow
        ? t('errKeepListEmpty') || 'Add at least one site to keep first.'
        : t('errNoActiveRules') || 'No active rules yet.',
    };
  }

  const res = await sweepHistory(live, dryRun ? 'preview' : 'manual', { dryRun, allow });
  if (!dryRun) await bumpStats(res.deleted, 'manual');
  return {
    ok: true,
    dryRun: !!dryRun,
    ...res,
    extra: clearExtraToo ? await clearExtra('manual') : null,
  };
}

/** The page in front of the user. A keyboard command counts as a gesture, which is what
 *  activeTab is granted on, so this works from the shortcut without the tabs permission. */
async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? tab.url : '';
  } catch (e) {
    log('could not read the active tab', e);
    return '';
  }
}

/** Take one site's entries out of history, now.
 *
 *  This is the keyboard shortcut's whole job. It deletes the exact URLs history hands back
 *  and nothing else, and it uses the same site comparison a rule for that site would use,
 *  so a shortcut can never reach beyond the site you are looking at. It does not touch the
 *  list: a shortcut is for the page in front of you. */
async function wipeSiteNow(url) {
  const site = normalizeDomain(url || '');
  if (!site) return { ok: false, error: t('errNoSite') || 'No site to wipe.' };
  const found = await chrome.history.search({ text: site, startTime: 0, maxResults: 0 });
  const onSite = found.filter((entry) => entry.url && normalizeDomain(entry.url) === site);
  const kept = await activeKeeps();
  const targets = onSite.filter((entry) => !explainExempt(entry, kept));
  if (!targets.length && onSite.length && kept.length) {
    try {
      await tell(t('notifyKept', [site]));
    } catch (e) {
      log('could not tell about the kept site', e);
    }
    log('kept by a never-delete rule:', site, onSite.length, 'entries');
    return { ok: true, wiped: 0, kept: true };
  }
  let wiped = 0;
  for (const entry of targets) {
    try {
      await chrome.history.deleteUrl({ url: entry.url });
      wiped += 1;
    } catch (e) {
      log('deleteUrl failed', entry.url, e);
    }
  }
  await notifySite(site, wiped);
  log('wipe this site:', site, wiped, 'entries');
  return { ok: true, wiped, site };
}

/**
 * What the person visits a lot and no rule covers: the suggestion side of the product.
 * Read when the settings page asks, never in the background, and never stored. The
 * answer is a list of hosts and counts that lives on screen until the page reloads.
 */
async function readInsights() {
  const { rules } = await getState();
  const live = activeRules(rules);
  const started = Date.now();
  const entries = [];
  const seen = new Set();
  let endTime = Date.now() + 60 * 1000; // the same small future pad the sweep uses

  for (let page = 0; page < INSIGHT_PAGES; page += 1) {
    if (Date.now() - started > INSIGHT_BUDGET_MS) break;
    let batch;
    try {
      batch = await chrome.history.search({
        text: '',
        startTime: 0, // an omitted startTime means the last 24h, so it must be explicit
        endTime,
        maxResults: INSIGHT_PAGE_SIZE,
      });
    } catch (e) {
      log('the history read behind the suggestions failed', e);
      break;
    }
    if (!batch || !batch.length) break;
    let oldest = null;
    let fresh = 0;
    for (const item of batch) {
      if (!item || !item.url) continue;
      const at = item.lastVisitTime || 0;
      if (at && (oldest === null || at < oldest)) oldest = at;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      fresh += 1;
      entries.push(item);
    }
    if (!fresh) break; // nothing new on that page, so stop rather than spin
    if (batch.length < INSIGHT_PAGE_SIZE) break;
    if (oldest === null) break;
    endTime = oldest - 1;
  }

  return { items: rankUncovered(entries, live, INSIGHT_LIMIT), scanned: entries.length };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'wipeSiteNow') {
    const target = msg.url || '';
    wipeSiteNow(target)
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'wipeNow') {
    manualRun(false)
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'preview') {
    manualRun(true)
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  // The pill on the add row. The page sends the ids of the rules it just wrote, and only
  // those run, beside the keep list, so an older visit to a page a keep rule covers is
  // left alone whatever the new rule says.
  if (msg.type === 'clearPast') {
    (async () => {
      const { settings, rules } = await getState();
      const wanted = new Set(Array.isArray(msg.ids) ? msg.ids : []);
      const live = activeRules(rules);
      const fresh = live.filter((rule) => wanted.has(rule.id) && !rule.exempt);
      if (!fresh.length || isKeepMode(settings)) {
        return { ok: true, scanned: 0, deleted: 0, matched: 0 };
      }
      const keeps = live.filter((rule) => rule.exempt);
      const res = await sweepHistory(keeps.concat(fresh), 'manual', { allow: false });
      if (res.deleted) await bumpStats(res.deleted, 'manual');
      return { ok: true, ...res };
    })()
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  // The separate button for the extra clear, so cookies and cache can go without
  // touching the history at all.
  if (msg.type === 'clearExtra') {
    clearExtra('manual')
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'pruneCookies') {
    (async () => {
      const { settings } = await getState();
      const res = await pruneCookies(settings);
      if (res.removed) {
        await pushLog([
          {
            url: '(cookies)',
            title: `${res.removed} cookie${res.removed === 1 ? '' : 's'} cleared`,
            rule: 'cookie keep list',
            at: Date.now(),
            phase: 'manual',
          },
        ]);
      }
      return res;
    })()
      .then(reply)
      .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'wipePreview') {
    (async () => {
      const { rules } = await getState();
      const live = activeRules(rules);
      // No deletion here. The options page "tester" does its own matching.
      reply({ ok: true, activeRules: live.length });
    })().catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'insights') {
    readInsights()
      .then((out) => reply({ ok: true, ...out }))
      .catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});

// Best-effort "the browser is closing" hook. Chrome does not wait for
// extensions on shutdown, so this is opportunistic only. The guaranteed
// cleanup happens in runSessionStart() on the next launch.
let windowCount = null;

async function trackWindows() {
  try {
    const wins = await chrome.windows.getAll();
    windowCount = wins.length;
  } catch {
    windowCount = null;
  }
}

chrome.windows.onCreated.addListener(() => {
  windowCount = (windowCount === null ? 1 : windowCount + 1);
});

chrome.windows.onRemoved.addListener(async () => {
  if (windowCount !== null && windowCount > 0) windowCount -= 1;
  if (windowCount !== 0) return;
  const { settings } = await getState();
  if (!settings.enabled) return;
  if (settings.mode !== 'onclose') return;
  try {
    if (settings.wipeAllHistory) {
      const res = await wipeEverything('close');
      await bumpStats(res.deleted, 'close');
    } else {
      await flushPending('close');
    }
  } catch (e) {
    log('best-effort close flush failed', e);
  }
});

// Run once whenever this worker is spun up.
trackWindows().catch(() => {});
bootOnce().catch((e) => log('boot failed', e));
