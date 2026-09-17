// Lil Bro: History Wipe
// Service worker. The only place that deletes anything.

import { findMatch, isWipeableUrl } from './matcher.js';
import {
  getState,
  saveState,
  activeRules,
  describeRule,
  buildRule,
  normalizeDomain,
} from './store.js';

const SWEEP_TIME_BUDGET_MS = 4 * 60 * 1000; // stay well inside the 5 min per-request cap
const SWEEP_PAGE_SIZE = 1000;
const DELETE_CHUNK = 25;
const PENDING_CAP = 5000;
const PREVIEW_SAMPLE = 25;

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

async function notify(count, phase) {
  if (!count) return;
  const { settings } = await getState();
  if (!settings.notifyOnWipe) return;
  try {
    await chrome.notifications.create('lilbro-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Lil Bro',
      message: `Wiped ${count} ${count === 1 ? 'entry' : 'entries'} from history (${phase}).`,
    });
  } catch (e) {
    log('notification failed', e);
  }
}

async function ensureMenus() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'lb-add-domain',
      title: 'Lil Bro: wipe this site from history',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'lb-add-url',
      title: 'Lil Bro: wipe this exact page',
      contexts: ['page', 'link'],
    });
  } catch (e) {
    log('menu setup failed', e);
  }
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/**
 * Delete already-matched items. targets: [{ url, title, rule }]
 * Returns the number actually deleted.
 */
async function wipeTargets(targets, phase) {
  let deleted = 0;
  const logEntries = [];

  for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
    const chunk = targets.slice(i, i + DELETE_CHUNK);
    for (const t of chunk) {
      try {
        // deleteUrl needs the URL exactly as history.search() returned it.
        await chrome.history.deleteUrl({ url: t.url });
        deleted++;
        logEntries.push({
          url: t.url,
          title: t.title || '',
          rule: describeRule(t.rule),
          at: Date.now(),
          phase,
        });
      } catch (e) {
        log('deleteUrl failed', t.url, e);
      }
    }
  }

  await pushLog(logEntries);
  return deleted;
}

/**
 * Full scan of the local history database, newest first, paginated by
 * lastVisitTime. Deletes everything matching `rules`, unless dryRun, in which
 * case it only reports what it found.
 */
async function sweepHistory(rules, phase, { budgetMs = SWEEP_TIME_BUDGET_MS, dryRun = false } = {}) {
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
      const rule = findMatch(item, rules);
      if (!rule) continue;
      matched++;
      if (sample.length < PREVIEW_SAMPLE) {
        sample.push({ url: item.url, title: item.title || '', rule: describeRule(rule) });
      }
      targets.push({ url: item.url, title: item.title || '', rule });
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

/**
 * Erase the entire history database. Only reachable when the user has switched on
 * the "wipe all history" toggle, never from the rule engine.
 */
async function wipeEverything(phase) {
  const counted = await countHistory();
  try {
    await chrome.history.deleteAll();
  } catch (e) {
    log('deleteAll failed', e);
    return { deleted: 0 };
  }
  await pushLog([
    { url: '(entire history)', title: '', rule: 'wipe all history', at: Date.now(), phase },
  ]);
  await withLock(async () => saveState({ pending: [] }));
  return { deleted: counted };
}

// ---------------------------------------------------------------------------
// deferred queue (used by "when I close" / "when I start")
// ---------------------------------------------------------------------------

async function queuePending(item, rule) {
  return withLock(async () => {
    const { pending } = await getState();
    if (pending.length >= PENDING_CAP) return;
    if (pending.some((p) => p.url === item.url)) return;
    pending.push({
      url: item.url,
      title: item.title || '',
      rule: describeRule(rule),
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
    rule: { type: 'domain', value: p.rule, includeSubdomains: false },
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
      await notify(wiped, phase);
      return { deleted: wiped, wipeAll: true, skipped: !shouldWipeAtBoot };
    }

    const live = activeRules(rules);
    let deleted = 0;

    // 1. Always flush whatever the previous session queued up.
    if (settings.mode === 'onclose' || settings.mode === 'startup') {
      deleted += await flushPending(phase);
    }

    // 2. Optional deep scan (catches entries that predate the rules).
    if (settings.sweepExistingOnStartup && live.length) {
      const res = await sweepHistory(live, phase);
      deleted += res.deleted;
    }

    await bumpStats(deleted, phase);
    await notify(deleted, phase);
    return { deleted };
  } finally {
    startupInFlight = false;
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
      [{ url: item.url, title: item.title || '', rule: WIPE_ALL_RULE }],
      'realtime'
    );
    if (deleted) await bumpStats(deleted, 'realtime');
    return;
  }

  const live = activeRules(rules);
  if (!live.length) return;

  const rule = findMatch(item, live);
  if (!rule) return;

  if (settings.mode === 'realtime') {
    const deleted = await wipeTargets(
      [{ url: item.url, title: item.title || '', rule }],
      'realtime'
    );
    if (deleted) await bumpStats(deleted, 'realtime');
    return;
  }

  await queuePending(item, rule);
}

chrome.history.onVisited.addListener((item) => {
  handleVisit(item).catch((e) => log('handleVisit failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  runSessionStart('startup').catch((e) => log('startup run failed', e));
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureMenus().catch(() => {});
  if (details.reason === 'install' || details.reason === 'update') {
    bootOnce().catch((e) => log('boot run failed', e));
  }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.pageUrl || '';
  const { rules } = await getState();
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

/** Shared by the popup and options page: "Wipe now" and the read-only preview. */
async function manualRun(dryRun) {
  const { settings, rules } = await getState();
  if (!settings.enabled) return { ok: false, error: 'Lil Bro is paused.' };

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
    };
  }

  const live = activeRules(rules);
  if (!live.length) return { ok: false, error: 'No active rules yet.' };

  const res = await sweepHistory(live, dryRun ? 'preview' : 'manual', { dryRun });
  if (!dryRun) await bumpStats(res.deleted, 'manual');
  return { ok: true, dryRun: !!dryRun, ...res };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return false;

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

  if (msg.type === 'wipePreview') {
    (async () => {
      const { rules } = await getState();
      const live = activeRules(rules);
      // No deletion here. The options page "tester" does its own matching.
      reply({ ok: true, activeRules: live.length });
    })().catch((e) => reply({ ok: false, error: String(e) }));
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
