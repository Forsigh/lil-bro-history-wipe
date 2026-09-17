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
        return db.items
          .filter((i) => (i.lastVisitTime || 0) >= startTime && (i.lastVisitTime || 0) <= endTime)
          .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
          .slice(0, maxResults)
          .map((i) => ({ ...i }));
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
      async remove() {
        db.forbidden.push('browsingData.remove');
        db.calls.browsingData++;
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
    tabs: { query: async () => [] },
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
  const mod = await import(`../service-worker.js?case=${++importCounter}`);
  assert.ok(mod, 'worker module loaded');
  // Wait until the boot run has finished writing stats.
  await waitFor('boot run to finish', () => store.local.stats && store.local.stats.lastRunAt);
}

/** Same, but for the paused case where a healthy worker intentionally writes nothing. */
async function bootNoWait(chromeFake) {
  await sleep(80);
  globalThis.chrome = chromeFake;
  const mod = await import(`../service-worker.js?case=${++importCounter}`);
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
  const { DEFAULT_SETTINGS } = await import('../store.js');
  check('wipe-all: off by default', () => assert.equal(DEFAULT_SETTINGS.wipeAllHistory, false));

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
  const { DEFAULT_SETTINGS, readRules, writeRules, chunkRules, saveState } = await import('../store.js');
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

  // --- rules sync ---------------------------------------------------------
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: 'r' + i,
    type: 'domain',
    value: `site${i}.example`,
    includeSubdomains: i % 2 === 0,
    wholeWord: false,
    enabled: true,
    createdAt: 1_700_000_000_000 + i,
  }));
  check('sync: a large list is split across items', () => assert.ok(chunkRules(many).length > 1));
  check('sync: no chunk gets near the 8 KB item cap', () =>
    assert.ok(chunkRules(many).every((c) => JSON.stringify(c).length <= 8000)));

  const s = makeFakeChrome([], { syncItemLimit: 8192 });
  globalThis.chrome = s.chrome;
  const wrote = await writeRules(many);
  check('sync: the write reports success', () => assert.equal(wrote, true));
  check('sync: the list landed in sync, chunked', () => {
    const keys = Object.keys(s.store.sync).filter((k) => k.startsWith('rulesChunk'));
    assert.ok(keys.length > 1, `only ${keys.length} chunk(s)`);
    assert.equal(s.store.sync.rulesMeta.count, 300);
  });
  check('sync: every chunk is under the per-item cap', () =>
    assert.ok(
      Object.entries(s.store.sync)
        .filter(([k]) => k.startsWith('rulesChunk'))
        .every(([, v]) => JSON.stringify(v).length <= 8192)
    ));
  const readBack = await readRules();
  check('sync: the whole list reads back in order', () => {
    assert.equal(readBack.length, 300);
    assert.equal(readBack[0].value, 'site0.example');
    assert.equal(readBack[299].value, 'site299.example');
  });
  check('sync: the local mirror matches', () => {
    assert.equal(s.store.local.rulesMirror.length, 300);
    assert.equal(s.store.local.rules.length, 300);
  });

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

  // Deleting every rule must survive a round trip, not resurrect the old list.
  await writeRules([]);
  const emptied = await readRules();
  check('sync: an emptied list stays empty', () => assert.equal(emptied.length, 0));
  check('sync: the meta says the list is empty on purpose', () =>
    assert.equal(s.store.sync.rulesMeta.count, 0));

  // A list that only exists locally (pre-sync, or sync switched off) is copied up.
  const legacy = makeFakeChrome([]);
  legacy.store.local.rules = [{ id: 'old1', type: 'domain', value: 'legacy.example', enabled: true }];
  globalThis.chrome = legacy.chrome;
  const migrated = await readRules();
  check('sync: a local-only list is read', () => assert.equal(migrated[0].value, 'legacy.example'));
  check('sync: and copied up to sync', () =>
    assert.equal(legacy.store.sync.rulesMeta.count, 1));

  // Sync unavailable: wiping still works from the local mirror.
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
  await waitFor('offline wipe from the local mirror', () => offline.db.deleted.length >= 1);
  await sleep(60);
  check('sync off: the rules still load', () => assert.ok(offline.db.deleted.includes('https://bad.example/x')));
  check('sync off: only the match went', () => assert.deepEqual(offline.db.deleted, ['https://bad.example/x']));
  check('sync off: the local mirror still holds the list', () =>
    assert.equal(offline.store.local.rulesMirror[0].value, 'bad.example'));
  const offlineRead = await readRules();
  check('sync off: reading falls back to the mirror', () => assert.equal(offlineRead.length, 1));
}

console.log(`\nworker: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
