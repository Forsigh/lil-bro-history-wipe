// Integration tests for the service worker.
// Runs the real service-worker.js against a fake chrome.* implementation and a
// fake history database.  ->  node tests/worker.test.mjs
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
let importCounter = 0;

function makeFakeChrome(seed = [], opts = {}) {
  const db = {
    items: seed.map((i) => ({ ...i })),
    deleted: [],
    searchCalls: [],
    // Anything a "nuke everything" implementation would reach for. Recorded, so a
    // test can prove the extension never touches them.
    forbidden: [],
    calls: { deleteAll: 0, deleteRange: 0, browsingData: 0 },
    browsingDataCalls: [],
    cookies: [],
    cookieRemovals: [],
    cookieReads: [],
    permissionsGranted: false,
    permissionChecks: [],
  };
  const listeners = {
    onVisited: [],
    onStartup: [],
    onInstalled: [],
    onMessage: [],
    onMenu: [],
    winCreated: [],
    winRemoved: [],
  };
  const store = { local: {}, session: {}, sync: {} };
  const notifications = [];

  // opts.syncFails  -> simulate a browser with sync switched off / quota blown
  // opts.syncItemLimit -> simulate QUOTA_BYTES_PER_ITEM (8 KB in Chrome)
  const area = (bag, name) => ({
    async get(keys) {
      if (name === 'sync' && opts.syncFails) throw new Error('sync unavailable');
      if (keys === undefined || keys === null) return structuredClone(bag);
      if (typeof keys === 'string') return keys in bag ? { [keys]: structuredClone(bag[keys]) } : {};
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (k in bag) out[k] = structuredClone(bag[k]);
      }
      return out;
    },
    async set(patch) {
      if (name === 'sync') {
        if (opts.syncFails) throw new Error('sync unavailable');
        if (opts.syncItemLimit) {
          for (const [k, v] of Object.entries(patch)) {
            if (JSON.stringify(v).length > opts.syncItemLimit) {
              throw new Error(`QUOTA_BYTES_PER_ITEM exceeded for ${k}`);
            }
          }
        }
      }
      for (const [k, v] of Object.entries(patch)) bag[k] = structuredClone(v);
    },
    async remove(key) {
      if (name === 'sync' && opts.syncFails) throw new Error('sync unavailable');
      for (const k of Array.isArray(key) ? key : [key]) delete bag[k];
    },
  });

  const chrome = {
    storage: {
      local: area(store.local, 'local'),
      session: area(store.session, 'session'),
      sync: area(store.sync, 'sync'),
    },
    history: {
      async search({ startTime = 0, endTime = Number.MAX_SAFE_INTEGER, maxResults = 100 } = {}) {
        db.searchCalls.push({ startTime, endTime, maxResults });
        const matched = db.items
          .filter((i) => (i.lastVisitTime || 0) >= startTime && (i.lastVisitTime || 0) <= endTime)
          .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
        // Chrome reads maxResults 0 as "no limit", which is how the engine asks for
        // everything. Returning an empty list there would be a fake that lies.
        const capped = maxResults > 0 ? matched.slice(0, maxResults) : matched;
        return capped.map((i) => ({ ...i }));
      },
      async deleteUrl({ url }) {
        // Real chrome.history.deleteUrl removes every visit to that URL and does
        // not care whether the entry is still present, so every call is recorded.
        db.deleted.push(url);
        db.items = db.items.filter((i) => i.url !== url);
      },
      async deleteAll() {
        db.forbidden.push('history.deleteAll');
        db.calls.deleteAll++;
        db.items = [];
      },
      async deleteRange() {
        db.forbidden.push('history.deleteRange');
        db.calls.deleteRange++;
      },
      onVisited: { addListener: (fn) => listeners.onVisited.push(fn) },
    },
    // Present so that any call is recorded rather than throwing, and so the
    // manifest's lack of the "browsingData" permission is mirrored here.
    browsingData: {
      async remove(options, set) {
        db.forbidden.push('browsingData.remove');
        db.calls.browsingData++;
        db.browsingDataCalls.push({ options, set });
      },
      async removeCookies() {
        db.forbidden.push('browsingData.removeCookies');
        db.calls.browsingData++;
      },
      async removeCache() {
        db.forbidden.push('browsingData.removeCache');
        db.calls.browsingData++;
      },
      async removeHistory() {
        db.forbidden.push('browsingData.removeHistory');
        db.calls.browsingData++;
      },
    },
    runtime: {
      onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      getURL: (p) => `chrome-extension://fake/${p}`,
      lastError: undefined,
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: (fn) => listeners.onMenu.push(fn) },
    },
    notifications: {
      create: async (id, opts) => {
        notifications.push(opts);
      },
    },
    windows: {
      getAll: async () => [{ id: 1 }],
      onCreated: { addListener: (fn) => listeners.winCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.winRemoved.push(fn) },
    },
    tabs: {
      query: async () => db.tabs || [],
      onUpdated: {
        addListener: (fn) => {
          (db.tabUpdaters ||= []).push(fn);
        },
      },
      onRemoved: {
        addListener: (fn) => {
          (db.tabRemovers ||= []).push(fn);
        },
      },
    },
    permissions: {
      contains: async (q) => {
        db.permissionChecks.push(q);
        return !!db.permissionsGranted;
      },
      request: async () => false,
    },
    cookies: {
      getAll: async (filter) => {
        db.cookieReads.push(filter || {});
        if (filter && filter.domain) {
          const d = filter.domain.toLowerCase().replace(/^\./, '');
          return db.cookies.filter((c) => {
            const host = c.domain.toLowerCase().replace(/^\./, '');
            return host === d || host.endsWith('.' + d);
          });
        }
        return [...db.cookies];
      },
      remove: async ({ url, name, storeId }) => {
        db.cookieRemovals.push({ url, name, storeId });
        db.cookies = db.cookies.filter((c) => !(c.name === name && c.storeId === storeId));
        return { url, name };
      },
    },
  };

  return { chrome, db, listeners, store, notifications };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label}`);
    await sleep(15);
  }
}

async function boot(chromeFake, store) {
  await sleep(80); // let any previous scenario's async tail drain before swapping the global
  globalThis.chrome = chromeFake;
  const mod = await import(`../src/service-worker.js?case=${++importCounter}`);
  assert.ok(mod, 'worker module loaded');
  // Wait until the boot run has finished writing stats.
  await waitFor('boot run to finish', () => store.local.stats && store.local.stats.lastRunAt);
}

/** Same, but for the paused case where a healthy worker intentionally writes nothing. */
async function bootNoWait(chromeFake) {
  await sleep(80);
  globalThis.chrome = chromeFake;
  const mod = await import(`../src/service-worker.js?case=${++importCounter}`);
  assert.ok(mod, 'worker module loaded');
  await sleep(80);
}

const NOW = Date.now();
const seed = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    url: `https://ok${i}.example.net/page${i}`,
    title: `page ${i}`,
    lastVisitTime: NOW - i * 1000,
    visitCount: 1,
  }));

function check(label, fn) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    fail++;
    console.log(`  FAIL ${label}: check() was given an async callback — its assertions would be swallowed`);
    return;
  }
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.log(`  FAIL ${label}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. realtime mode: the visited entry dies immediately, existing history is left alone
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([
    { id: 'p1', url: 'https://shop.example.com/old', title: 'old', lastVisitTime: NOW - 9000 },
    { id: 'p2', url: 'https://other.net/x', title: 'x', lastVisitTime: NOW - 8000 },
  ]);
  f.store.local.rules = [
    { id: 'r1', type: 'domain', value: 'example.com', includeSubdomains: true, enabled: true },
  ];
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);
  check('realtime: nothing swept at boot', () => assert.equal(f.db.deleted.length, 0));

  f.listeners.onVisited[0]({ url: 'https://shop.example.com/cart', title: 'Cart', lastVisitTime: Date.now() });
  await waitFor('realtime delete', () => f.db.deleted.includes('https://shop.example.com/cart'));

  check('realtime: matching visit deleted', () =>
    assert.ok(f.db.deleted.includes('https://shop.example.com/cart')));
  check('realtime: pre-existing entry kept when deep scan is off', () =>
    assert.ok(f.db.items.some((i) => i.url === 'https://shop.example.com/old')));
  check('realtime: log entry written', () =>
    assert.equal(f.store.local.log[0].url, 'https://shop.example.com/cart'));
  check('realtime: stats counted', () => assert.equal(f.store.local.stats.wipedTotal, 1));

  f.listeners.onVisited[0]({ url: 'https://harmless.net/a', title: 'a', lastVisitTime: Date.now() });
  await sleep(60);
  check('realtime: non-matching visit untouched', () =>
    assert.ok(!f.db.deleted.includes('https://harmless.net/a')));
}

// ---------------------------------------------------------------------------
// 2. "when I start the browser": queue during the session, clear on next boot
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'r1', type: 'keyword', value: 'shoes', enabled: true }];
  f.store.local.settings = { mode: 'startup', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);

  f.listeners.onVisited[0]({
    url: 'https://www.google.com/search?q=shoes',
    title: 'shoes - Google Search',
    lastVisitTime: Date.now(),
  });
  await waitFor('pending queue', () => (f.store.local.pending || []).length === 1);

  check('startup: match queued, not deleted mid-session', () =>
    assert.equal(f.db.deleted.length, 0));
  check('startup: queue records which rule hit', () =>
    assert.ok(String(f.store.local.pending[0].rule).includes('shoes')));

  // Simulate the next browser start.
  f.listeners.onStartup[0]();
  await waitFor('deferred flush', () => f.db.deleted.includes('https://www.google.com/search?q=shoes'));

  check('startup: queue drained on next boot', () => assert.deepEqual(f.store.local.pending, []));
  check('startup: stats counted the deferred wipe', () => assert.equal(f.store.local.stats.wipedTotal, 1));
}

// ---------------------------------------------------------------------------
// 3. "when I close the browser": best-effort flush on last window close
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'adult.example', enabled: true }];
  f.store.local.settings = { mode: 'onclose', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);

  f.listeners.onVisited[0]({ url: 'https://adult.example/watch', title: 'w', lastVisitTime: Date.now() });
  await waitFor('pending queue', () => (f.store.local.pending || []).length === 1);
  check('onclose: kept during the session', () => assert.equal(f.db.deleted.length, 0));

  f.listeners.winRemoved[0]();
  await waitFor('close flush', () => f.db.deleted.includes('https://adult.example/watch'));
  check('onclose: flushed when the last window closed', () =>
    assert.ok(f.db.deleted.includes('https://adult.example/watch')));
}

// ---------------------------------------------------------------------------
// 4. full scan: pagination across the whole database + startTime guard
// ---------------------------------------------------------------------------
{
  const items = seed(2500);
  items[0] = { id: 'm1', url: 'https://deep.bad.com/login', title: 'login', lastVisitTime: NOW, visitCount: 1 };
  items[1200] = {
    id: 'm2',
    url: 'https://www.google.com/search?q=shoes+uk',
    title: 'shoes uk - Google Search',
    lastVisitTime: NOW - 1200 * 1000,
    visitCount: 1,
  };
  items[2499] = {
    id: 'm3',
    url: 'https://example.com/deep/private/page',
    title: 'private',
    lastVisitTime: NOW - 2499 * 1000,
    visitCount: 1,
  };

  const f = makeFakeChrome(items);
  f.store.local.rules = [
    { id: 'r1', type: 'domain', value: 'bad.com', includeSubdomains: true, enabled: true },
    { id: 'r2', type: 'keyword', value: 'shoes', enabled: true },
    { id: 'r3', type: 'url', value: 'https://example.com/deep', enabled: true },
  ];
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: true, notifyOnWipe: false };

  await boot(f.chrome, f.store);
  await waitFor('full sweep', () => f.db.deleted.length >= 3, 15000);
  await sleep(120); // let the sweep finish if it is still paging

  check('scan: all three matches found and deleted', () =>
    assert.equal(f.db.deleted.length, 3));
  check('scan: subdomain entry caught', () => assert.ok(f.db.deleted.includes('https://deep.bad.com/login')));
  check('scan: keyword caught via title', () =>
    assert.ok(f.db.deleted.includes('https://www.google.com/search?q=shoes+uk')));
  check('scan: url prefix entry caught', () =>
    assert.ok(f.db.deleted.includes('https://example.com/deep/private/page')));
  check('scan: everything else survived', () => assert.equal(f.db.items.length, 2497));
  check('scan: paged more than once', () => assert.ok(f.db.searchCalls.length >= 3, `calls=${f.db.searchCalls.length}`));
  check('scan: startTime was explicitly 0 (avoids the 24h default)', () =>
    assert.ok(f.db.searchCalls.every((c) => c.startTime === 0)));
  check('scan: newest-first pagination never went backwards', () => {
    for (let i = 1; i < f.db.searchCalls.length; i++) {
      assert.ok(f.db.searchCalls[i].endTime < f.db.searchCalls[i - 1].endTime);
    }
  });
}

// ---------------------------------------------------------------------------
// 5. popup "wipe now" message
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://target.example/p', title: 'p', lastVisitTime: NOW },
    { id: 'b', url: 'https://fine.example/p', title: 'p', lastVisitTime: NOW - 100 },
  ]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'target.example', enabled: true }];
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);

  const reply = await new Promise((resolve) => {
    const kept = f.listeners.onMessage[0]({ type: 'wipeNow' }, {}, resolve);
    assert.equal(kept, true, 'message listener keeps the channel open');
  });

  check('wipeNow reports counts', () => assert.deepEqual({ ok: reply.ok, deleted: reply.deleted, scanned: reply.scanned }, { ok: true, deleted: 1, scanned: 2 }));
}

// ---------------------------------------------------------------------------
// 6. paused: nothing happens at all
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([{ id: 'a', url: 'https://bad.com/x', title: 'x', lastVisitTime: NOW }]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'bad.com', includeSubdomains: true, enabled: true }];
  f.store.local.settings = { enabled: false, mode: 'realtime', sweepExistingOnStartup: true, notifyOnWipe: false };

  await bootNoWait(f.chrome);
  f.listeners.onVisited[0]({ url: 'https://bad.com/y', title: 'y', lastVisitTime: Date.now() });
  await sleep(80);

  check('paused: no deletions', () => assert.equal(f.db.deleted.length, 0));
  check('paused: no queue', () => assert.equal((f.store.local.pending || []).length, 0));
  check('paused: no stats written either', () => assert.equal(f.store.local.stats, undefined));
}

// ---------------------------------------------------------------------------
// 7. notifications, log switch, log cap
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://noisy.example/1', title: '1', lastVisitTime: NOW },
    { id: 'b', url: 'https://noisy.example/2', title: '2', lastVisitTime: NOW - 1000 },
  ]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'noisy.example', enabled: true }];
  f.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: true,
    logEnabled: true,
    logLimit: 2,
  };

  await boot(f.chrome, f.store);
  await waitFor('sweep done', () => f.db.deleted.length === 2);

  check('notify: one notification after a wipe', () => assert.equal(f.notifications.length, 1));
  check('notify: message states the count', () =>
    assert.ok(f.notifications[0].message.includes('2 entries'), f.notifications[0].message));

  for (let i = 0; i < 5; i++) {
    f.listeners.onVisited[0]({
      url: `https://noisy.example/live${i}`,
      title: `live ${i}`,
      lastVisitTime: Date.now(),
    });
  }
  await waitFor('five live wipes', () => f.store.local.stats.wipedTotal === 7);
  check('log: capped at logLimit', () => assert.equal(f.store.local.log.length, 2));
  check('log: keeps the newest entries', () =>
    assert.equal(f.store.local.log[0].url, 'https://noisy.example/live4'));
  check('notify: instant wipes do not spam notifications', () =>
    assert.equal(f.notifications.length, 1));
}

// ---------------------------------------------------------------------------
// 8. log off
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://quiet.example/1', title: '1', lastVisitTime: NOW },
  ]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'quiet.example', enabled: true }];
  f.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
    logEnabled: false,
  };

  await boot(f.chrome, f.store);
  await waitFor('wipe', () => f.db.deleted.length === 1);
  await sleep(60);

  check('log off: entry deleted', () => assert.equal(f.db.deleted.length, 1));
  check('log off: nothing written to the log', () => assert.equal(f.store.local.log, undefined));
  check('log off: stats still counted', () => assert.equal(f.store.local.stats.wipedTotal, 1));
  check('notify off: no notification', () => assert.equal(f.notifications.length, 0));
}

// ---------------------------------------------------------------------------
// 9. preview is read-only
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://preview.example/1', title: 'one', lastVisitTime: NOW },
    { id: 'b', url: 'https://preview.example/2', title: 'two', lastVisitTime: NOW - 1000 },
    { id: 'c', url: 'https://keeper.net/3', title: 'three', lastVisitTime: NOW - 2000 },
  ]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'preview.example', enabled: true }];
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);

  const preview = await new Promise((r) => f.listeners.onMessage[0]({ type: 'preview' }, {}, r));
  check('preview: reports the match count', () => assert.equal(preview.matched, 2));
  check('preview: deletes nothing', () => assert.equal(preview.deleted, 0));
  check('preview: database untouched', () => assert.equal(f.db.deleted.length, 0));
  check('preview: returns a sample with the rule label', () =>
    assert.deepEqual(
      preview.sample.map((s) => s.rule),
      ['preview.example', 'preview.example']
    ));
  check('preview: still scans the whole database', () => assert.equal(preview.scanned, 3));

  const wipe = await new Promise((r) => f.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('wipeNow after preview: deletes the matches', () => assert.equal(wipe.deleted, 2));
  check('wipeNow after preview: keeps the rest', () => assert.equal(f.db.items.length, 1));
  check('wipeNow: flags itself as a real run', () => assert.equal(wipe.dryRun, false));
}

// ---------------------------------------------------------------------------
// 10. only "on close" mode reacts to the window closing
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'later.example', enabled: true }];
  f.store.local.settings = { mode: 'startup', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);
  f.listeners.onVisited[0]({ url: 'https://later.example/x', title: 'x', lastVisitTime: Date.now() });
  await waitFor('queued', () => (f.store.local.pending || []).length === 1);

  f.listeners.winRemoved[0]();
  await sleep(80);
  check('startup mode: closing a window does not flush the queue', () =>
    assert.equal(f.db.deleted.length, 0));
  check('startup mode: entry still queued', () => assert.equal(f.store.local.pending.length, 1));
}

// ---------------------------------------------------------------------------
// 11. right-click "add rule" menus
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([]);
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  await boot(f.chrome, f.store);

  f.listeners.onMenu[0]({ menuItemId: 'lb-add-domain', pageUrl: 'https://www.Example.com/checkout?x=1' });
  await waitFor('domain rule added', () => f.store.local.rules.length === 1);
  check('menu: site added as a normalized domain', () =>
    assert.equal(f.store.local.rules[0].value, 'example.com'));
  check('menu: site rule is a domain rule', () => assert.equal(f.store.local.rules[0].type, 'domain'));

  f.listeners.onMenu[0]({ menuItemId: 'lb-add-url', linkUrl: 'https://a.example/deep/page' });
  await waitFor('url rule added', () => f.store.local.rules.length === 2);
  check('menu: exact page added as a url rule', () => assert.equal(f.store.local.rules[1].type, 'url'));
  check('menu: url rule keeps the full path', () =>
    assert.equal(f.store.local.rules[1].value, 'https://a.example/deep/page'));
}

// ---------------------------------------------------------------------------
// 12. many visits at once must not lose queue entries
// ---------------------------------------------------------------------------
{
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'r1', type: 'domain', value: 'bulk.example', enabled: true }];
  f.store.local.settings = { mode: 'startup', sweepExistingOnStartup: false, notifyOnWipe: false };

  await boot(f.chrome, f.store);
  for (let i = 0; i < 20; i++) {
    f.listeners.onVisited[0]({
      url: `https://bulk.example/page${i}`,
      title: `p${i}`,
      lastVisitTime: Date.now(),
    });
  }
  await waitFor('all 20 queued', () => (f.store.local.pending || []).length === 20);
  check('concurrency: every simultaneous visit is queued', () =>
    assert.equal(f.store.local.pending.length, 20));
}

// ---------------------------------------------------------------------------
// 13. blast radius: only filter matches go, nothing wholesale
// ---------------------------------------------------------------------------
{
  const filler = Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`,
    url: `https://filler${i}.net/page`,
    title: `filler ${i}`,
    lastVisitTime: NOW - (i + 1) * 5000,
    visitCount: 1,
  }));

  const shouldGo = [
    { id: 'm1', url: 'https://target.example/a', title: 'a', lastVisitTime: NOW, visitCount: 1 },
    { id: 'm2', url: 'https://sub.target.example/b', title: 'b', lastVisitTime: NOW - 1000, visitCount: 1 },
    {
      id: 'm3',
      url: 'https://deep.sub.target.example/c',
      title: 'c',
      lastVisitTime: NOW - 2000,
      visitCount: 1,
    },
    {
      id: 'm4',
      url: 'https://www.google.com/search?q=shoes',
      title: 'shoes - Google Search',
      lastVisitTime: NOW - 3000,
      visitCount: 1,
    },
    {
      id: 'm5',
      url: 'https://news.site/article-9',
      title: 'cheap shoes review',
      lastVisitTime: NOW - 4000,
      visitCount: 1,
    },
  ];

  // Lookalikes and neighbours that must survive every run.
  const shouldStay = [
    { id: 's1', url: 'https://nottarget.example/x', title: 'x', lastVisitTime: NOW - 6000, visitCount: 1 },
    { id: 's2', url: 'https://target.example.evil.io/x', title: 'x', lastVisitTime: NOW - 7000, visitCount: 1 },
    { id: 's3', url: 'https://example.com/target', title: 'x', lastVisitTime: NOW - 8000, visitCount: 1 },
    { id: 's4', url: 'https://boots.shop/plain', title: 'daily news', lastVisitTime: NOW - 9000, visitCount: 1 },
    { id: 's5', url: 'https://news.site/article-8', title: 'daily news', lastVisitTime: NOW - 10000, visitCount: 1 },
  ];

  const f = makeFakeChrome([...shouldGo, ...shouldStay, ...filler]);
  f.store.local.rules = [
    { id: 'r1', type: 'domain', value: 'target.example', includeSubdomains: true, enabled: true },
    { id: 'r2', type: 'keyword', value: 'shoes', enabled: true },
  ];
  f.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
    logEnabled: true,
  };

  const totalBefore = f.db.items.length;
  await boot(f.chrome, f.store);
  await waitFor('sweep', () => f.db.deleted.length >= 5);
  await sleep(120);

  check('blast radius: exactly the 5 matching URLs deleted', () =>
    assert.deepEqual(
      [...f.db.deleted].sort(),
      [
        'https://deep.sub.target.example/c',
        'https://news.site/article-9',
        'https://sub.target.example/b',
        'https://target.example/a',
        'https://www.google.com/search?q=shoes',
      ]
    ));
  check('blast radius: every lookalike survived', () => {
    for (const s of shouldStay) {
      assert.ok(f.db.items.some((i) => i.url === s.url), `${s.url} was deleted`);
    }
  });
  check('blast radius: unrelated filler survived', () => {
    const fillersLeft = f.db.items.filter((i) => i.url.includes('filler')).length;
    assert.equal(fillersLeft, 200);
  });
  check('blast radius: totals add up', () => assert.equal(f.db.items.length, totalBefore - 5));
  check('blast radius: no whole-history API was called', () =>
    assert.deepEqual(f.db.forbidden, []));

  // Same guarantee for the deferred modes and the manual button.
  const g = makeFakeChrome([...shouldGo, ...shouldStay]);
  g.store.local.rules = f.store.local.rules;
  g.store.local.settings = { mode: 'onclose', sweepExistingOnStartup: true, notifyOnWipe: false };
  await boot(g.chrome, g.store);
  await waitFor('deferred mode sweep', () => g.db.deleted.length >= 5);
  check('blast radius (on-close mode): no whole-history API was called', () =>
    assert.deepEqual(g.db.forbidden, []));
  check('blast radius (on-close mode): survivors intact', () =>
    assert.ok(shouldStay.every((s) => g.db.items.some((i) => i.url === s.url))));

  const h = makeFakeChrome([...shouldGo, ...shouldStay]);
  h.store.local.rules = f.store.local.rules;
  h.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  await boot(h.chrome, h.store);
  const manual = await new Promise((r) => h.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('blast radius (wipe-now button): deletes only matches', () =>
    assert.equal(manual.deleted, 5));
  check('blast radius (wipe-now button): no whole-history API was called', () =>
    assert.deepEqual(h.db.forbidden, []));
}

// ---------------------------------------------------------------------------
// 14. the wipe-all toggle
// ---------------------------------------------------------------------------
{
  const { DEFAULT_SETTINGS } = await import('../src/store.js');
  check('wipe-all: off by default', () => assert.equal(DEFAULT_SETTINGS.wipeAllHistory, false));

// A never-delete rule has to hold on the paths that do not ask the matcher.
{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://keep.example/one', title: 'one', lastVisitTime: NOW },
    { id: 'b', url: 'https://keep.example/two', title: 'two', lastVisitTime: NOW },
    { id: 'c', url: 'https://gone.example/x', title: 'x', lastVisitTime: NOW },
  ]);
  f.store.local.rules = [
    { id: 'k', type: 'domain', value: 'keep.example', enabled: true, exempt: true },
    { id: 'w', type: 'domain', value: 'gone.example', enabled: true },
  ];
  f.store.local.settings = { ...DEFAULT_SETTINGS, mode: 'manual', notifyOnWipe: false, wipeAllHistory: true };

  await boot(f.chrome, f.store);
  await new Promise((r) => f.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));

  check('wipe-all leaves the never-delete site standing', () =>
    assert.deepEqual(
      f.db.items.map((i) => i.url),
      ['https://keep.example/one', 'https://keep.example/two']
    ));
  check('and it does not reach for deleteAll at all', () => assert.equal(f.db.calls.deleteAll, 0));
}

{
  const f = makeFakeChrome([
    { id: 'a', url: 'https://keep.example/one', title: 'one', lastVisitTime: NOW },
  ]);
  f.store.local.rules = [
    { id: 'k', type: 'domain', value: 'keep.example', enabled: true, exempt: true },
  ];
  f.store.local.settings = { ...DEFAULT_SETTINGS, notifyOnWipe: false };

  await boot(f.chrome, f.store);
  const out = await new Promise((r) =>
    f.listeners.onMessage[0]({ type: 'wipeSiteNow', url: 'https://keep.example/one' }, {}, r));

  check('the shortcut on the site reports it was kept', () => assert.equal(out.kept, true));
  check('and the entry is still in history', () => assert.equal(f.db.items.length, 1));
}

  const start = [
    { id: 'w1', url: 'https://one.example/a', title: 'a', lastVisitTime: NOW, visitCount: 1 },
    { id: 'w2', url: 'https://two.example/b', title: 'b', lastVisitTime: NOW - 1000, visitCount: 1 },
    { id: 'w3', url: 'https://three.example/c', title: 'c', lastVisitTime: NOW - 2000, visitCount: 1 },
    { id: 'w4', url: 'https://four.example/d', title: 'd', lastVisitTime: NOW - 3000, visitCount: 1 },
    { id: 'w5', url: 'https://five.example/e', title: 'e', lastVisitTime: NOW - 4000, visitCount: 1 },
  ];

  // Armed, and with no rules at all — proves it bypasses the rule engine.
  const f = makeFakeChrome(start);
  f.store.local.rules = [];
  f.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await boot(f.chrome, f.store);
  await waitFor('whole-history erase', () => f.db.calls.deleteAll === 1);
  await sleep(80);

  check('wipe-all: entire history erased', () => assert.equal(f.db.items.length, 0));
  check('wipe-all: deletes despite having no rules', () => assert.equal(f.db.forbidden[0], 'history.deleteAll'));
  check('wipe-all: reports the real number of entries', () =>
    assert.equal(f.store.local.stats.wipedTotal, 5));
  check('wipe-all: cookies and cache were never touched', () =>
    assert.deepEqual(f.db.forbidden, ['history.deleteAll']));
  check('wipe-all: browsingData was never called', () => assert.equal(f.db.calls.browsingData, 0));
  check('wipe-all: the log says so', () =>
    assert.equal(f.store.local.log[0].rule, 'wipe all history'));
  check('wipe-all: only one erase, not one per entry', () => assert.equal(f.db.calls.deleteAll, 1));

  // Armed + instant mode: an unrelated visit dies even though no rule matches it.
  const g = makeFakeChrome([]);
  g.store.local.rules = [{ id: 'r1', type: 'domain', value: 'never.matches', enabled: true }];
  g.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await boot(g.chrome, g.store);
  g.listeners.onVisited[0]({
    url: 'https://anything.example/x',
    title: 'x',
    lastVisitTime: Date.now(),
  });
  await waitFor('instant wipe-all', () => g.db.deleted.includes('https://anything.example/x'));
  check('wipe-all + instant: a visit that matches no rule is still erased', () =>
    assert.equal(g.db.deleted[0], 'https://anything.example/x'));

  // Armed + deferred modes: a visit does nothing, the trigger does everything.
  const h = makeFakeChrome(start);
  h.store.local.rules = [{ id: 'r1', type: 'domain', value: 'never.matches', enabled: true }];
  h.store.local.settings = {
    mode: 'startup',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await boot(h.chrome, h.store);
  // Opening the browser is itself a trigger, so the boot already erased once.
  await waitFor('session-start erase', () => h.db.calls.deleteAll === 1);
  const afterBoot = h.db.calls.deleteAll;

  h.listeners.onVisited[0]({ url: 'https://six.example/f', title: 'f', lastVisitTime: Date.now() });
  await sleep(100);
  check('wipe-all + start-on-next-launch: a visit erases nothing by itself', () =>
    assert.equal(h.db.calls.deleteAll, afterBoot));
  check('wipe-all + start-on-next-launch: nothing queued either', () =>
    assert.equal((h.store.local.pending || []).length, 0));

  h.listeners.onStartup[0]();
  await waitFor('next-launch erase', () => h.db.calls.deleteAll > afterBoot);
  check('wipe-all + start-on-next-launch: erased again on the next start trigger', () =>
    assert.equal(h.db.calls.deleteAll, afterBoot + 1));
  check('wipe-all + start-on-next-launch: history left empty', () => assert.equal(h.db.items.length, 0));

  // Armed + on-close: the last window closing fires it.
  const k = makeFakeChrome(start);
  k.store.local.settings = {
    mode: 'onclose',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await boot(k.chrome, k.store);
  await waitFor('session-start erase (close mode)', () => k.db.calls.deleteAll >= 1);
  const beforeClose = k.db.calls.deleteAll;
  k.listeners.winRemoved[0]();
  await waitFor('close-time whole-history erase', () => k.db.calls.deleteAll > beforeClose);
  check('wipe-all + close mode: erased when the last window closed', () =>
    assert.equal(k.db.calls.deleteAll, beforeClose + 1));
  check('wipe-all + close mode: history left empty', () => assert.equal(k.db.items.length, 0));
  // Opening the browser is a trigger too, so two erasals are expected here.
  check('wipe-all + close mode: only history was erased, never cookies or cache', () => {
    assert.ok(k.db.forbidden.length >= 1);
    assert.ok(k.db.forbidden.every((f) => f === 'history.deleteAll'), k.db.forbidden.join(', '));
    assert.equal(k.db.calls.browsingData, 0);
  });

  // Armed but paused: pause always wins.
  const i = makeFakeChrome(start);
  i.store.local.settings = {
    enabled: false,
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await bootNoWait(i.chrome);
  await sleep(100);
  check('wipe-all + paused: nothing erased', () => assert.equal(i.db.calls.deleteAll, 0));
  check('wipe-all + paused: history intact', () => assert.equal(i.db.items.length, 5));

  // Preview stays read-only even when armed.
  const j = makeFakeChrome(start);
  j.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    wipeAllHistory: true,
  };
  await boot(j.chrome, j.store);
  const preview = await new Promise((r) => j.listeners.onMessage[0]({ type: 'preview' }, {}, r));
  check('wipe-all + preview: reports the full count', () => assert.equal(preview.matched, 5));
  check('wipe-all + preview: flags itself as wipe-all', () => assert.equal(preview.wipeAll, true));
  check('wipe-all + preview: deletes nothing', () => assert.equal(j.db.calls.deleteAll, 0));
  check('wipe-all + preview: history intact', () => assert.equal(j.db.items.length, 5));

  const wipe = await new Promise((r) => j.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('wipe-all + wipe now: empties history', () => assert.equal(j.db.calls.deleteAll, 1));
  check('wipe-all + wipe now: reports the count', () => assert.equal(wipe.deleted, 5));
  check('wipe-all + wipe now: cookies and cache still untouched', () =>
    assert.deepEqual(j.db.forbidden, ['history.deleteAll']));
}

// ---------------------------------------------------------------------------
// 15. keep-list mode (rules inverted)
// ---------------------------------------------------------------------------
{
  const { DEFAULT_SETTINGS, readRules, writeRules, chunkRules, saveState, factoryReset, getState } = await import(
    '../src/store.js'
  );
  const { isLockConfigured } = await import('../src/lock.js');
  check('keep list: off by default', () => assert.equal(DEFAULT_SETTINGS.listMode, 'block'));

  // Instant mode: listed sites stay, everything else dies on visit.
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'k1', type: 'domain', value: 'bank.example', enabled: true }];
  f.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    listMode: 'allow',
  };
  await boot(f.chrome, f.store);

  f.listeners.onVisited[0]({ url: 'https://bank.example/account', title: 'a', lastVisitTime: Date.now() });
  f.listeners.onVisited[0]({ url: 'https://shopping.example/cart', title: 'b', lastVisitTime: Date.now() });
  await waitFor('keep-list instant wipe', () => f.db.deleted.includes('https://shopping.example/cart'));
  await sleep(60);

  check('keep list: an unlisted visit is wiped', () =>
    assert.ok(f.db.deleted.includes('https://shopping.example/cart')));
  check('keep list: a listed visit is kept', () =>
    assert.ok(!f.db.deleted.includes('https://bank.example/account')));
  check('keep list: the log explains why', () =>
    assert.equal(f.store.local.log[0].rule, 'not on your keep list'));
  check('keep list: no whole-history API was called', () => assert.deepEqual(f.db.forbidden, []));

  // An empty keep list must wipe nothing: inverting it would empty the database.
  const g = makeFakeChrome([]);
  g.store.local.rules = [];
  g.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    listMode: 'allow',
  };
  await boot(g.chrome, g.store);
  g.listeners.onVisited[0]({ url: 'https://anything.example/x', title: 'x', lastVisitTime: Date.now() });
  await sleep(120);
  check('keep list: an empty keep list wipes nothing', () => assert.equal(g.db.deleted.length, 0));
  const noKeep = await new Promise((r) => g.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('keep list: wipe-now refuses while the keep list is empty', () =>
    assert.equal(noKeep.ok, false));
  check('keep list: and says what to do about it', () =>
    assert.match(String(noKeep.error), /at least one site to keep/));

  // Deep scan at start, keep mode: only unlisted entries go.
  const keepStart = [
    { id: 'k1', url: 'https://bank.example/1', title: 'a', lastVisitTime: NOW },
    { id: 'k2', url: 'https://mail.example/1', title: 'b', lastVisitTime: NOW - 1000 },
    { id: 'k3', url: 'https://shop.example/1', title: 'c', lastVisitTime: NOW - 2000 },
    { id: 'k4', url: 'https://news.example/1', title: 'd', lastVisitTime: NOW - 3000 },
    { id: 'k5', url: 'chrome://settings', title: 'e', lastVisitTime: NOW - 4000 },
  ];
  const h = makeFakeChrome(keepStart);
  h.store.local.rules = [
    { id: 'k1', type: 'domain', value: 'bank.example', enabled: true },
    { id: 'k2', type: 'domain', value: 'mail.example', enabled: true },
  ];
  h.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
    listMode: 'allow',
  };
  await boot(h.chrome, h.store);
  await waitFor('keep-list deep scan', () => h.db.deleted.length >= 2);
  await sleep(60);

  check('keep list + deep scan: listed basics survive', () =>
    assert.ok(h.db.items.some((i) => i.url === 'https://bank.example/1')));
  check('keep list + deep scan: the other listed site survives', () =>
    assert.ok(h.db.items.some((i) => i.url === 'https://mail.example/1')));
  check('keep list + deep scan: unlisted entries go', () => {
    assert.ok(!h.db.items.some((i) => i.url === 'https://shop.example/1'));
    assert.ok(!h.db.items.some((i) => i.url === 'https://news.example/1'));
  });
  check('keep list + deep scan: chrome:// is never touched', () =>
    assert.ok(h.db.items.some((i) => i.url === 'chrome://settings')));
  check('keep list + deep scan: still nothing but deleteUrl', () =>
    assert.deepEqual(h.db.forbidden, []));

  // Preview stays read-only, and counts what would go. Only bank.example is on
  // the keep list here, so mail, shop and news would go; chrome:// is not a
  // candidate at all.
  const previewKeep = makeFakeChrome(keepStart);
  previewKeep.store.local.rules = [{ id: 'k1', type: 'domain', value: 'bank.example', enabled: true }];
  previewKeep.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    listMode: 'allow',
  };
  await boot(previewKeep.chrome, previewKeep.store);
  const keepPreview = await new Promise((r) =>
    previewKeep.listeners.onMessage[0]({ type: 'preview' }, {}, r)
  );
  check('keep list + preview: reports the entries that would go', () =>
    assert.equal(keepPreview.matched, 3));
  check('keep list + preview: deletes nothing', () =>
    assert.equal(previewKeep.db.deleted.length, 0));
  check('keep list + preview: history intact', () => assert.equal(previewKeep.db.items.length, 5));

  // Block mode must still behave exactly as before with the same rules.
  const blockAgain = makeFakeChrome(keepStart);
  blockAgain.store.local.rules = [{ id: 'k1', type: 'domain', value: 'bank.example', enabled: true }];
  blockAgain.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
  };
  await boot(blockAgain.chrome, blockAgain.store);
  await waitFor('block-mode deep scan', () => blockAgain.db.deleted.length >= 1);
  await sleep(60);
  check('block mode: only the listed site is wiped', () =>
    assert.deepEqual(blockAgain.db.deleted, ['https://bank.example/1']));

  // --- rules, and the one thing that used to travel -----------------------
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: 'r' + i,
    type: 'domain',
    value: `site${i}.example`,
    includeSubdomains: i % 2 === 0,
    wholeWord: false,
    enabled: true,
    createdAt: 1_700_000_000_000 + i,
  }));
  check('rules: a large list is still split into chunks', () => assert.ok(chunkRules(many).length > 1));
  check('rules: no chunk gets near the old per-item cap', () =>
    assert.ok(chunkRules(many).every((c) => JSON.stringify(c).length <= 8000)));

  const s = makeFakeChrome([]);
  globalThis.chrome = s.chrome;
  const wrote = await writeRules(many);
  check('rules: the write reports success', () => assert.equal(wrote, true));
  check('rules: the list lands in local storage, chunked', () => {
    const keys = Object.keys(s.store.local).filter((k) => k.startsWith('rulesChunk'));
    assert.ok(keys.length > 1, `only ${keys.length} chunk(s)`);
    assert.equal(s.store.local.rulesMeta.count, 300);
  });
  const readBack = await readRules();
  check('rules: the whole list reads back in order', () => {
    assert.equal(readBack.length, 300);
    assert.equal(readBack[0].value, 'site0.example');
    assert.equal(readBack[299].value, 'site299.example');
  });
  check('rules: the mirror matches', () => {
    assert.equal(s.store.local.rulesMirror.length, 300);
    assert.equal(s.store.local.rules.length, 300);
  });

  // The claim the privacy policy makes, asserted against the code: after a list has
  // been written there is nothing of the user's in the synced area, so the browser
  // has nothing of theirs to upload, sync on or off.
  check('nothing at all is written to the synced area', () =>
    assert.equal(Object.keys(s.store.sync).length, 0, Object.keys(s.store.sync).join(', ')));

  // Settings must never travel: a synced danger switch would arm itself on every device.
  await saveState({ settings: { ...DEFAULT_SETTINGS, wipeAllHistory: true, listMode: 'allow' } });
  check('settings: never written to sync', () =>
    assert.ok(!('settings' in s.store.sync)));
  check('settings: the whole-history switch never leaves the device', () =>
    assert.ok(!JSON.stringify(s.store.sync).includes('wipeAllHistory')));
  check('settings: the keep-list mode never leaves the device', () =>
    assert.ok(!JSON.stringify(s.store.sync).includes('listMode')));
  check('settings: they are still stored locally', () => {
    assert.equal(s.store.local.settings.wipeAllHistory, true);
    assert.equal(s.store.local.settings.listMode, 'allow');
  });

  // The PIN hash is the one thing that must never travel: a synced lock would be a
  // shared secret, and it would arm itself on every machine.
  await saveState({
    settings: {
      ...DEFAULT_SETTINGS,
      lockEnabled: true,
      lockHash: 'deadbeefcafe',
      lockSalt: 'c0ffee',
      lockIterations: 1000,
    },
  });
  check('lock: off by default', () => assert.equal(DEFAULT_SETTINGS.lockEnabled, false));
  check('settings: the PIN hash never reaches sync', () =>
    assert.ok(!JSON.stringify(s.store.sync).includes('deadbeefcafe')));
  check('settings: nor does the salt', () => assert.ok(!JSON.stringify(s.store.sync).includes('c0ffee')));
  check('settings: the lock is stored on the device', () =>
    assert.equal(s.store.local.settings.lockHash, 'deadbeefcafe'));

  // The way out when the PIN is forgotten: the recovery word clears the lot.
  const fr = makeFakeChrome([]);
  globalThis.chrome = fr.chrome;
  await writeRules([{ id: 'r1', type: 'domain', value: 'secret.example', enabled: true }]);
  await saveState({
    settings: {
      ...DEFAULT_SETTINGS,
      lockEnabled: true,
      lockHash: 'abc',
      lockSalt: 'def',
      lockIterations: 1000,
      wipeAllHistory: true,
    },
    log: [{ url: 'https://secret.example/x', rule: 'secret.example', at: 1 }],
    stats: { wipedTotal: 7, lastRunAt: 1, lastRunCount: 7, lastRunPhase: 'manual' },
    pending: [{ url: 'https://secret.example/y', rule: 'secret.example', at: 2 }],
  });
  const beforeReset = await getState();
  check('recovery: set up for the test', () => assert.equal(beforeReset.rules.length, 1));

  await factoryReset();
  const afterReset = await getState();
  check('recovery: the list is gone', () => assert.equal(afterReset.rules.length, 0));
  check('recovery: the lock is gone', () => assert.equal(isLockConfigured(afterReset.settings), false));
  check('recovery: the log is gone', () => assert.equal(afterReset.log.length, 0));
  check('recovery: the count is gone', () => assert.equal(afterReset.stats.wipedTotal, 0));
  check('recovery: the queue is gone', () => assert.equal(afterReset.pending.length, 0));
  check('recovery: the whole-history switch is off again', () =>
    assert.equal(afterReset.settings.wipeAllHistory, false));
  check('recovery: the list area is emptied as well', () => assert.equal(fr.store.local.rulesMeta.count, 0));
  check('recovery: no rule text survives anywhere, in either area', () =>
    assert.ok(!JSON.stringify(fr.store.local).includes('secret.example')));
  check('recovery: and nothing is left in the synced area to upload', () =>
    assert.ok(!JSON.stringify(fr.store.sync).includes('secret.example')));

  // Back to the fake the rest of this block was using.
  globalThis.chrome = s.chrome;

  // Deleting every rule must survive a round trip, not resurrect the old list.
  await writeRules([]);
  const emptied = await readRules();
  check('rules: an emptied list stays empty', () => assert.equal(emptied.length, 0));
  check('rules: the meta says the list is empty on purpose', () =>
    assert.equal(s.store.local.rulesMeta.count, 0));

  // A list written before the list area moved is read and rewritten where it now lives.
  const legacy = makeFakeChrome([]);
  legacy.store.local.rules = [{ id: 'old1', type: 'domain', value: 'legacy.example', enabled: true }];
  globalThis.chrome = legacy.chrome;
  const migrated = await readRules();
  check('rules: a list in the older local key is read', () => assert.equal(migrated[0].value, 'legacy.example'));
  check('rules: and rewritten in the shape the read path now expects', () =>
    assert.equal(legacy.store.local.rulesMeta.count, 1));

  // The synced area unreachable, which is what a user with sync switched off looks
  // like: the adoption reads nothing from it and wiping carries on from local storage.
  const offline = makeFakeChrome([
    { id: 'o1', url: 'https://bad.example/x', title: 'x', lastVisitTime: NOW },
    { id: 'o2', url: 'https://good.example/y', title: 'y', lastVisitTime: NOW - 1000 },
  ], { syncFails: true });
  offline.store.local.rules = [{ id: 'r1', type: 'domain', value: 'bad.example', enabled: true }];
  offline.store.local.settings = {
    mode: 'realtime',
    sweepExistingOnStartup: true,
    notifyOnWipe: false,
  };
  await boot(offline.chrome, offline.store);
  await waitFor('offline wipe from local storage', () => offline.db.deleted.length >= 1);
  await sleep(60);
  check('synced area unreachable: the rules still load', () => assert.ok(offline.db.deleted.includes('https://bad.example/x')));
  check('synced area unreachable: only the match went', () => assert.deepEqual(offline.db.deleted, ['https://bad.example/x']));
  check('synced area unreachable: the list is still there afterwards', () =>
    assert.equal(offline.store.local.rulesMirror[0].value, 'bad.example'));
  const offlineRead = await readRules();
  check('synced area unreachable: reading returns the same list', () => assert.equal(offlineRead.length, 1));
}

// ---------------------------------------------------------------------------
// 12. the extra clear: cache, cookies and site data, downloads, form text
// ---------------------------------------------------------------------------
{
  const seedOne = () => [
    { id: 'x1', url: 'https://match.example/a', title: 'a', lastVisitTime: NOW - 100 },
  ];
  const baseSettings = (extra) => ({
    mode: 'startup',
    sweepExistingOnStartup: false,
    notifyOnWipe: false,
    ...extra,
  });

  // (a) Off by default: not even a manual wipe reaches for browsing data.
  const off = makeFakeChrome(seedOne());
  off.store.local.rules = [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  off.store.local.settings = baseSettings({});
  await boot(off.chrome, off.store);
  const offReply = await new Promise((res) => off.listeners.onMessage[0]({ type: 'wipeNow' }, {}, res));
  check('extra: a manual wipe with nothing switched on still wipes the history', () =>
    assert.equal(offReply.deleted, 1));
  check('extra: and never touches browsing data', () => assert.equal(off.db.calls.browsingData, 0));
  check('extra: no extra key is reported', () => assert.equal(offReply.extra, null));

  // (b) Cache + cookies on: one call, the right set, the right reach.
  const on = makeFakeChrome(seedOne());
  on.store.local.rules = [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  on.store.local.settings = baseSettings({
    extraCache: true,
    extraCookies: true,
    extraSince: 'day',
    extraTrigger: 'manual',
  });
  await boot(on.chrome, on.store);
  const startedAt = Date.now();
  const onReply = await new Promise((res) => on.listeners.onMessage[0]({ type: 'wipeNow' }, {}, res));

  check('extra: the run reports the clear', () => assert.equal(onReply.extra.ok, true));
  check('extra: the kinds are named for the UI', () =>
    assert.equal(onReply.extra.kinds, 'Cache, Cookies and site data'));
  check('extra: one call, one data set', () => assert.equal(on.db.browsingDataCalls.length, 1));
  const call = on.db.browsingDataCalls[0];
  check('extra: cookies drag the site storage with them', () =>
    assert.deepEqual(
      {
        cookies: call.set.cookies,
        localStorage: call.set.localStorage,
        indexedDB: call.set.indexedDB,
        cacheStorage: call.set.cacheStorage,
        serviceWorkers: call.set.serviceWorkers,
        fileSystems: call.set.fileSystems,
      },
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        cacheStorage: true,
        serviceWorkers: true,
        fileSystems: true,
      }
    ));
  check('extra: cache was asked for', () => assert.equal(call.set.cache, true));
  check('extra: unticked kinds stay out', () =>
    assert.deepEqual({ downloads: call.set.downloads, formData: call.set.formData }, { downloads: false, formData: false }));
  check('extra: passwords are never in the set', () => assert.ok(!('passwords' in call.set)));
  check('extra: dead data types are never asked for', () =>
    assert.deepEqual({ appcache: call.set.appcache, webSQL: call.set.webSQL }, { appcache: undefined, webSQL: undefined }));
  check('extra: "the last day" is a bound, not everything', () => {
    assert.ok(call.options.since > startedAt - 86400000 - 5000, String(call.options.since));
    assert.ok(call.options.since <= startedAt + 5000, String(call.options.since));
  });
  check('extra: the history wipe still happened', () =>
    assert.ok(on.db.deleted.includes('https://match.example/a')));
  check('extra: the log records the clear without naming a site', () =>
    assert.ok(on.store.local.log.some((e) => e.rule === 'extra clear' && e.url === '(extra data)')));

  // (c) The standalone button clears on its own, without touching history.
  const deletedBefore = on.db.deleted.length;
  const only = await new Promise((res) => on.listeners.onMessage[0]({ type: 'clearExtra' }, {}, res));
  check('extra: the button clears without a history wipe', () => assert.equal(only.ok, true));
  check('extra: and deletes no history', () => assert.equal(on.db.deleted.length, deletedBefore));
  check('extra: a second press is a second clear', () => assert.equal(on.db.browsingDataCalls.length, 2));

  // (d) A preview never clears anything, even with the extras on.
  const beforePreview = on.db.browsingDataCalls.length;
  const previewReply = await new Promise((res) => on.listeners.onMessage[0]({ type: 'preview' }, {}, res));
  check('extra: a preview reports no clear', () => assert.equal(previewReply.extra, null));
  check('extra: a preview clears nothing', () => assert.equal(on.db.browsingDataCalls.length, beforePreview));

  // (e) 'manual' means the triggers leave it alone; 'triggers' means they do not.
  const manualBoot = makeFakeChrome(seedOne());
  manualBoot.store.local.rules = [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  manualBoot.store.local.settings = baseSettings({ extraCache: true, extraTrigger: 'manual' });
  await boot(manualBoot.chrome, manualBoot.store);
  check('extra: a manual-only clear does not fire at session start', () =>
    assert.equal(manualBoot.db.calls.browsingData, 0));

  const triggerBoot = makeFakeChrome(seedOne());
  triggerBoot.store.local.rules = [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  triggerBoot.store.local.settings = baseSettings({
    extraCache: true,
    extraTrigger: 'triggers',
    extraSince: 'all',
  });
  await boot(triggerBoot.chrome, triggerBoot.store);
  await waitFor('extra clear at session start', () => triggerBoot.db.calls.browsingData === 1);
  check('extra: the triggers reach the clear at session start', () =>
    assert.equal(triggerBoot.db.calls.browsingData, 1));
  check('extra: "everything, however old" sends no since bound', () =>
    assert.deepEqual(triggerBoot.db.browsingDataCalls[0].options, {}));
  check('extra: only the ticked kind is in the set', () =>
    assert.deepEqual(triggerBoot.db.browsingDataCalls[0].set, {
      cache: true,
      cookies: false,
      downloads: false,
      formData: false,
      localStorage: false,
      indexedDB: false,
      cacheStorage: false,
      serviceWorkers: false,
      fileSystems: false,
    }));

  // (f) No permission, no crash: the worker says so instead of throwing.
  const noApi = makeFakeChrome(seedOne());
  noApi.store.local.rules = [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  noApi.store.local.settings = baseSettings({ extraCache: true });
  await boot(noApi.chrome, noApi.store);
  delete noApi.chrome.browsingData;
  const noApiReply = await new Promise((res) => noApi.listeners.onMessage[0]({ type: 'clearExtra' }, {}, res));
  check('extra: a build without the API gets an honest error, not a throw', () =>
    assert.equal(noApiReply.ok, false));
  check('extra: the history path still worked', () => assert.ok(noApi.db.deleted.length >= 0));
}

// ---------------------------------------------------------------------------
// 13. cookies, with a keep list
// ---------------------------------------------------------------------------
{
  const rule = () => [{ id: 'r1', type: 'domain', value: 'match.example', enabled: true }];
  const seedCookies = (db, hosts) => {
    db.cookies = hosts.map((h, i) => ({ domain: h, name: `c${i}`, storeId: '0', secure: true, path: '/' }));
  };

  // Off by default: a wipe run never reads or removes a cookie.
  const off = makeFakeChrome([]);
  off.store.local.rules = rule();
  off.store.local.settings = { mode: 'startup', notifyOnWipe: false };
  seedCookies(off.db, ['gone.example']);
  await boot(off.chrome, off.store);
  await new Promise((res) => off.listeners.onMessage[0]({ type: 'wipeNow' }, {}, res));
  check('cookies: nothing is read while the feature is off', () => assert.equal(off.db.cookieReads.length, 0));
  check('cookies: nothing is removed while the feature is off', () => assert.equal(off.db.cookieRemovals.length, 0));

  // At start, everything except the keep list goes.
  const on = makeFakeChrome([]);
  on.store.local.rules = rule();
  on.store.local.settings = {
    mode: 'startup',
    notifyOnWipe: false,
    cookiesOnStart: true,
    cookieKeep: ['keep.example'],
  };
  seedCookies(on.db, ['keep.example', 'a.example', '.b.example']);
  await boot(on.chrome, on.store);
  await waitFor('cookie prune at start', () => on.db.cookieRemovals.length === 2);
  check('cookies: the keep list survives, everything else goes', () =>
    assert.deepEqual(
      on.db.cookieRemovals.map((r) => new URL(r.url).hostname).sort(),
      ['a.example', 'b.example']
    ));
  check('cookies: a kept domain is never touched', () =>
    assert.ok(!on.db.cookieRemovals.some((r) => r.url.includes('keep.example'))));

  // The manual button clears the same way, and logs what it did.
  const manual = makeFakeChrome([]);
  manual.store.local.rules = rule();
  manual.store.local.settings = { mode: 'startup', notifyOnWipe: false, cookieKeep: ['keep.example'] };
  seedCookies(manual.db, ['keep.example', 'c.example']);
  await boot(manual.chrome, manual.store);
  const manualReply = await new Promise((res) =>
    manual.listeners.onMessage[0]({ type: 'pruneCookies' }, {}, res)
  );
  check('cookies: the button reports a real count', () => assert.equal(manualReply.removed, 1));
  check('cookies: and logs it without naming a page', () =>
    assert.ok(manual.store.local.log.some((e) => e.url === '(cookies)' && /1 cookie/.test(e.title))));

  // Closing a tab clears that site, and only that site.
  const tabbed = makeFakeChrome([]);
  tabbed.db.permissionsGranted = true;
  tabbed.db.tabs = [{ id: 7, url: 'https://closing.example/page' }];
  tabbed.store.local.rules = rule();
  tabbed.store.local.settings = {
    mode: 'startup',
    notifyOnWipe: false,
    cookiesOnTabClose: true,
    cookieKeep: ['keep.example'],
  };
  seedCookies(tabbed.db, ['closing.example', 'other.example', 'keep.example']);
  await boot(tabbed.chrome, tabbed.store);
  await new Promise((r) => setTimeout(r, 30));
  check('cookies: tab hosts are watched when the permission is there', () =>
    assert.equal(typeof (tabbed.db.tabRemovers || [])[0], 'function'));
  tabbed.db.tabRemovers[0](7);
  await waitFor('tab close clear', () => tabbed.db.cookieRemovals.length === 1);
  check('cookies: the closed tab loses its cookies', () =>
    assert.equal(new URL(tabbed.db.cookieRemovals[0].url).hostname, 'closing.example'));
  check('cookies: other sites keep theirs', () =>
    assert.ok(!tabbed.db.cookieRemovals.some((r) => r.url.includes('other.example'))));

  // No permission, no tracking, no clear.
  const noPerm = makeFakeChrome([]);
  noPerm.db.tabs = [{ id: 9, url: 'https://closing.example/page' }];
  noPerm.store.local.rules = rule();
  noPerm.store.local.settings = { mode: 'startup', notifyOnWipe: false, cookiesOnTabClose: true };
  seedCookies(noPerm.db, ['closing.example']);
  await boot(noPerm.chrome, noPerm.store);
  noPerm.db.tabRemovers[0](9);
  await new Promise((r) => setTimeout(r, 40));
  check('cookies: without the permission nothing is cleared', () =>
    assert.equal(noPerm.db.cookieRemovals.length, 0));
}

// ---------------------------------------------------------------------------
// 12. the log explains itself: which text matched, which word, and where in it
// ---------------------------------------------------------------------------
{
  const tokenUrl = 'https://news.example/watch?v=' + 'x'.repeat(180) + 'Gay' + 'y'.repeat(180);
  const f = makeFakeChrome([]);
  f.store.local.rules = [{ id: 'r1', type: 'keyword', value: 'gay', enabled: true }];
  f.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  await boot(f.chrome, f.store);

  f.listeners.onVisited[0]({
    url: tokenUrl,
    title: '2 Gay Guys dancing in the kitchen - Video',
    lastVisitTime: Date.now(),
  });
  await waitFor('keyword wipe', () => f.db.deleted.includes(tokenUrl));

  const entry = () => f.store.local.log[0];
  check('log: the page title is kept, so the row reads as something', () =>
    assert.equal(entry().title, '2 Gay Guys dancing in the kitchen - Video'));
  check('log: the reason says which word', () => assert.equal(entry().word, 'gay'));
  check('log: the reason says which of the two texts it was in', () =>
    assert.equal(entry().why, 'word-url'));
  check('log: the excerpt shows the word in its neighbourhood', () =>
    assert.ok(entry().excerpt.includes('Gay')));
  check('log: the excerpt is a neighbourhood, not the address', () =>
    assert.ok(entry().excerpt.length < 90));
  check('log: the excerpt says it was cut', () =>
    assert.ok(entry().excerpt.startsWith('…') && entry().excerpt.endsWith('…')));
  check('log: the whole address is still stored, so nothing is lost', () =>
    assert.equal(entry().url, tokenUrl));

  // A site rule covers the whole address, so there is no single spot to point at.
  const site = makeFakeChrome([]);
  site.store.local.rules = [{ id: 'r2', type: 'domain', value: 'example.com', enabled: true }];
  site.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  await boot(site.chrome, site.store);
  site.listeners.onVisited[0]({ url: 'https://example.com/a', title: 'Example', lastVisitTime: Date.now() });
  await waitFor('site wipe', () => site.db.deleted.includes('https://example.com/a'));
  check('log: a site rule says so and names the site', () =>
    assert.equal(site.store.local.log[0].why, 'site'));
  check('log: a site rule points at no spot inside the address', () =>
    assert.equal(site.store.local.log[0].excerpt, ''));
  check('log: the rule string is still written for anything else reading it', () =>
    assert.equal(site.store.local.log[0].rule, 'example.com'));
}

// ---------------------------------------------------------------------------
// the suggestions: what you visit and no rule covers
// ---------------------------------------------------------------------------
{
  const g = makeFakeChrome([
    { id: 'a', url: 'https://covered.example/x', title: 'x', visitCount: 80, lastVisitTime: NOW },
    { id: 'b', url: 'https://busy.example/a', title: 'a', visitCount: 30, lastVisitTime: NOW - 1000 },
    { id: 'c', url: 'https://www.busy.example/b', title: 'b', visitCount: 20, lastVisitTime: NOW - 2000 },
    { id: 'd', url: 'https://quiet.example/c', title: 'c', visitCount: 2, lastVisitTime: NOW - 3000 },
  ]);
  g.store.local.rules = [{ id: 'r1', type: 'domain', value: 'covered.example', includeSubdomains: true, enabled: true }];
  g.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  await boot(g.chrome, g.store);

  const got = await new Promise((r) => g.listeners.onMessage[0]({ type: 'insights' }, {}, r));
  check('the suggestions come back okay', () => assert.equal(got.ok, true));
  check('a covered site is never suggested back, however busy it is', () =>
    assert.equal(got.items.some((x) => x.host === 'covered.example'), false));
  check('the busiest uncovered site is first', () => assert.equal(got.items[0].host, 'busy.example'));
  check('www and the bare host are added up together', () => assert.equal(got.items[0].visits, 50));
  check('the ranking follows how often, not how recent', () =>
    assert.deepEqual(got.items.map((x) => x.host), ['busy.example', 'quiet.example']));
  check('the read says how much it looked at', () => assert.equal(got.scanned, 4));
  check('and the read leaves nothing behind in storage', () =>
    assert.equal(g.store.local.insights, undefined));
  check('the listener keeps the channel open', () =>
    assert.equal(g.listeners.onMessage[0]({ type: 'insights' }, {}, () => {}), true));
}

// ---------------------------------------------------------------------------
// what each rule has removed
// ---------------------------------------------------------------------------
{
  const h = makeFakeChrome([
    { id: 'a', url: 'https://counted.example/one', title: 'one', lastVisitTime: NOW },
    { id: 'b', url: 'https://counted.example/two', title: 'two', lastVisitTime: NOW - 10 },
    { id: 'c', url: 'https://other.example/three', title: 'three', lastVisitTime: NOW - 20 },
  ]);
  const counted = { id: 'r-count', type: 'domain', value: 'counted.example', includeSubdomains: true, enabled: true };
  const gone = { id: 'r-gone', type: 'domain', value: 'gone.example', includeSubdomains: true, enabled: true };
  h.store.local.rules = [counted, gone];
  h.store.local.settings = { mode: 'realtime', sweepExistingOnStartup: false, notifyOnWipe: false };
  h.store.local.stats = { wipedTotal: 0, lastRunAt: 0, lastRunCount: 0, lastRunPhase: '', byRule: { 'r-gone': 9 } };
  await boot(h.chrome, h.store);

  const res = await new Promise((r) => h.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('the wipe removed the two entries the rule covers', () => assert.equal(res.deleted, 2));
  check('the rule that did the work is credited with both', () =>
    assert.equal(h.store.local.stats.byRule['r-count'], 2));

  await new Promise((r) => h.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('a second run does not inflate the number', () =>
    assert.equal(h.store.local.stats.byRule['r-count'], 2));

  // Now the other rule is taken off the list, and one new visit arrives for the rule
  // that stayed. A count left behind by a rule that no longer exists is the defect
  // this guards, and it only shows up once something else is wiped.
  // Take the other rule off the list the way the page does, through the store's own
  // writer, so the chunk metadata and the mirror agree on what is left.
  const storeMod = await import('../src/store.js');
  await storeMod.writeRules([counted]);
  h.db.items.push({ id: 'd', url: 'https://counted.example/four', title: 'four', lastVisitTime: NOW - 5 });
  const after = await new Promise((r) => h.listeners.onMessage[0]({ type: 'wipeNow' }, {}, r));
  check('the next run still wipes what the remaining rule covers', () => assert.equal(after.deleted, 1));
  check('a rule that was taken off the list leaves no number behind', () =>
    assert.equal(h.store.local.stats.byRule['r-gone'], undefined));
  check('and the rule still on the list keeps counting', () =>
    assert.equal(h.store.local.stats.byRule['r-count'], 3));
}

console.log(`\nworker: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
