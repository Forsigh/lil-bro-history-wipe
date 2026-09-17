// Integration tests for the service worker.
// Runs the real service-worker.js against a fake chrome.* implementation and a
// fake history database.  ->  node tests/worker.test.mjs
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
let importCounter = 0;

function makeFakeChrome(seed = []) {
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
  const store = { local: {}, session: {} };
  const notifications = [];

  const area = (bag) => ({
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(bag);
      if (typeof keys === 'string') return keys in bag ? { [keys]: structuredClone(bag[keys]) } : {};
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (k in bag) out[k] = structuredClone(bag[k]);
      }
      return out;
    },
    async set(patch) {
      for (const [k, v] of Object.entries(patch)) bag[k] = structuredClone(v);
    },
    async remove(key) {
      delete bag[key];
    },
  });

  const chrome = {
    storage: { local: area(store.local), session: area(store.session) },
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

console.log(`\nworker: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
