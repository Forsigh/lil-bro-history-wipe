// Live feature probe: drives the real extension inside a real Chromium browser.
//
//   node tools/live_probe.mjs [port] [browser-exe]
//
// The mocked suite proves contracts; this proves behaviour in the browser that ships it:
// the worker boots with the permission set the manifest declares, the pages render, and the
// real chrome.history database loses exactly the entries a rule names and nothing else.
//
// Throwaway profile and a staged copy only. Never the live dev folder, never a real profile.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const port = Number(process.argv[2] || 9231);
const exe = process.argv[3] || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const base = `http://127.0.0.1:${port}`;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  [${detail}]`}`);
}

if (!existsSync(exe)) {
  console.error(`browser not found: ${exe}`);
  process.exit(2);
}

const stage = path.join(mkdtempSync(path.join(tmpdir(), 'lb-stage-')), 'ext');
cpSync(ROOT, stage, { recursive: true, filter: (p) => !/\.git|\.zip$/.test(p) });
const profile = mkdtempSync(path.join(tmpdir(), 'lb-prof-'));
let child = null;

async function launch(headless) {
  child = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${stage}`,
      `--disable-extensions-except=${stage}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1400,1000',
      // The UI follows the browser language, and the checks compare against English
      // strings, so the run pins the language instead of inheriting the machine's.
      '--lang=en',
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/json/version`)).ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

const targets = async () => {
  try {
    const r = await fetch(`${base}/json/list`);
    return await r.json();
  } catch {
    return [];
  }
};

async function findWorker(timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const t = await targets();
    const w = t.find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'));
    if (w) return w;
    await sleep(500);
  }
  return null;
}

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method && onEvent) onEvent(m);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  return { ws, ready, send, evaluate };
}

async function openPage(url, dialogs) {
  const page = await fetch(`${base}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json());
  // When a dialogs array is passed, answer any window.confirm this page opens by
  // dismissing it (accept: false) and record the text, so a question cannot hang the probe.
  let conn = null;
  const onEvent = dialogs
    ? (m) => {
        if (m.method === 'Page.javascriptDialogOpening') {
          dialogs.push(m.params.message);
          conn?.send('Page.handleJavaScriptDialog', { accept: false });
        }
      }
    : undefined;
  conn = connect(page.webSocketDebuggerUrl, onEvent);
  await conn.ready;
  await conn.send('Runtime.enable');
  if (dialogs) await conn.send('Page.enable');
  await sleep(1400); // let the module scripts and their storage reads settle
  conn.id = page.id;
  return conn;
}

const closePage = (id) => fetch(`${base}/json/close/${id}`).catch(() => {});

let worker = null;
let id = null;

try {
  const headlessOk = await launch(true);
  if (!headlessOk) throw new Error('browser never opened the debug port');
  let w = await findWorker();
  if (!w) {
    child.kill();
    await sleep(1500);
    await launch(false);
    w = await findWorker();
  }
  if (!w) throw new Error('the extension service worker never appeared');
  id = w.url.split('/')[2];

  worker = connect(w.webSocketDebuggerUrl);
  await worker.ready;
  await worker.send('Runtime.enable');
  const ev = worker.evaluate;

  // --- 1. the manifest the browser actually loaded -------------------------
  const manifestRaw = await ev('JSON.stringify(chrome.runtime.getManifest())');
  if (typeof manifestRaw !== 'string') {
    throw new Error(`could not read the manifest: ${JSON.stringify(manifestRaw).slice(0, 300)}`);
  }
  const m = JSON.parse(manifestRaw);
  record('worker boots in a real browser', !!m.manifest_version, `extension id ${id}`);
  record('manifest is MV3', m.manifest_version === 3, `manifest_version ${m.manifest_version}`);
  record('version is 1.5.3', m.version === '1.5.3', m.version);
  record(
    'permission set is the documented seven',
    JSON.stringify([...m.permissions].sort()) ===
      JSON.stringify([
        'activeTab',
        'browsingData',
        'contextMenus',
        'cookies',
        'history',
        'notifications',
        'storage',
      ]),
    m.permissions.join(', ')
  );

  // --- 2. the permission surface, in the real browser -----------------------
  const surface = await ev(
    'JSON.stringify({browsingData: typeof chrome.browsingData, cookies: typeof chrome.cookies, downloads: typeof chrome.downloads, sessions: typeof chrome.sessions, search: typeof chrome.history.search, del: typeof chrome.history.deleteUrl, delAll: typeof chrome.history.deleteAll})'
  );
  const s = JSON.parse(surface);
  record('cookies API present (the keep list needs it)', s.cookies === 'object', s.cookies);
  record(
    'tabs is optional, never required',
    Array.isArray(m.optional_permissions) &&
      m.optional_permissions.includes('tabs') &&
      !m.permissions.includes('tabs'),
    JSON.stringify(m.optional_permissions)
  );
  record('browsingData API present (permission declared)', s.browsingData === 'object', s.browsingData);
  record('downloads API absent (clearing uses browsingData instead)', s.downloads === 'undefined', s.downloads);
  record('history API present', s.search === 'function' && s.del === 'function', `search=${s.search}, deleteUrl=${s.del}`);

  // --- helpers -------------------------------------------------------------
  const seed = (urls) =>
    ev(`(async()=>{ for (const u of ${JSON.stringify(urls)}) await chrome.history.addUrl({url:u}); 
      const r = await chrome.history.search({text:'', startTime:0, maxResults:1000}); return r.map(x=>x.url); })()`);
  const clearHistory = () => ev('(async()=>{await chrome.history.deleteAll(); return true})()');
  const setStore = (patch) =>
    ev(`(async()=>{ const p = ${JSON.stringify(patch)}; const cur = await chrome.storage.local.get(null);
      await chrome.storage.local.set(p); return true; })()`);
  const resetStore = () =>
    ev('(async()=>{ await chrome.storage.local.clear(); await chrome.storage.sync.clear(); return true })()');
  const historyUrls = async () => {
    const list = await ev(
      "(async()=>{const r=await chrome.history.search({text:'',startTime:0,maxResults:1000});return r.map(x=>x.url).sort()})()"
    );
    return Array.isArray(list) ? list : [];
  };
  const note = (label, value) => console.log(`      ${label}: ${value}`);

  /**
   * A deterministic scenario: rules and settings first, then the history, then drain
   * whatever the visits queued. Startup mode is used deliberately, so a visit can only
   * queue an entry; the deletion under test is always the one "wipe now" performs.
   */
  async function scenario({ urls, rules, listMode = 'block', wipeAllHistory = false }) {
    await resetStore();
    await clearHistory();
    await setStore({
      rules,
      settings: {
        enabled: true,
        mode: 'startup',
        sweepExistingOnStartup: false,
        notifyOnWipe: false,
        listMode,
        wipeAllHistory,
      },
    });
    await sleep(250);
    await seed(urls);
    await sleep(400); // let the visit events be processed (queued, never deleted)
    await ev('chrome.storage.local.set({pending: []})'); // the queue is not what we are testing
    return openPage(`chrome-extension://${id}/src/options.html`);
  }

  // --- 3. block mode: wipe what matches, keep the lookalikes ---------------
  const opts = await scenario({
    urls: [
      'https://target.example/one',
      'https://deep.sub.target.example/two',
      'https://not-target.example/three',
      'https://target.example.evil.io/four',
      'https://unrelated.example/five',
    ],
    rules: [{ id: 'r1', type: 'domain', value: 'target.example', includeSubdomains: true, enabled: true }],
  });
  const seeded = await historyUrls();
  record('history seeded in the real profile', seeded.length >= 5, `${seeded.length} entries`);
  const preview = await opts.evaluate("chrome.runtime.sendMessage({type:'preview'})");
  record('preview counts the matches read-only', preview && preview.matched === 2, JSON.stringify(preview?.matched));
  const afterPreview = await historyUrls();
  record('preview deletes nothing', afterPreview.length === seeded.length, `${afterPreview.length} of ${seeded.length} still there`);

  const wipe = await opts.evaluate("chrome.runtime.sendMessage({type:'wipeNow'})");
  const left = await historyUrls();
  record('wipe removes exactly the matching entries', wipe && wipe.deleted === 2, `deleted ${wipe?.deleted}`);
  record(
    'lookalikes survived',
    left.includes('https://not-target.example/three') && left.includes('https://target.example.evil.io/four'),
    left.join(' ')
  );
  record('unrelated entry survived', left.includes('https://unrelated.example/five'));
  record(
    'both real matches are gone',
    !left.includes('https://target.example/one') && !left.includes('https://deep.sub.target.example/two')
  );
  await closePage(opts.id);

  // --- 4. keep-list mode: everything except the listed ones ----------------
  const opts2 = await scenario({
    urls: [
      'https://keep.example/one',
      'https://keep.example/two',
      'https://other.example/three',
      'https://another.example/four',
    ],
    rules: [{ id: 'k1', type: 'domain', value: 'keep.example', enabled: true }],
    listMode: 'allow',
  });
  const keepWipe = await opts2.evaluate("chrome.runtime.sendMessage({type:'wipeNow'})");
  const left2 = await historyUrls();
  record('keep list: only the unlisted entries go', keepWipe && keepWipe.deleted === 2, `deleted ${keepWipe?.deleted}`);
  record(
    'keep list: the listed entries survived',
    left2.includes('https://keep.example/one') && left2.includes('https://keep.example/two'),
    left2.join(' ')
  );
  record(
    'keep list: the unlisted ones are gone',
    !left2.includes('https://other.example/three') && !left2.includes('https://another.example/four')
  );
  await closePage(opts2.id);

  // --- 5. an empty keep list must not wipe the database --------------------
  const opts3 = await scenario({
    urls: ['https://a.example/1', 'https://b.example/2'],
    rules: [],
    listMode: 'allow',
  });
  const emptyKeep = await opts3.evaluate("chrome.runtime.sendMessage({type:'wipeNow'})");
  const left3 = await historyUrls();
  record('empty keep list wipes nothing', left3.length >= 2 && !!(emptyKeep && emptyKeep.ok === false), JSON.stringify(emptyKeep));
  await closePage(opts3.id);

  // --- 6. the regex guard, tested against the live worker ------------------
  const opts4 = await scenario({
    urls: ['https://regex.example/1'],
    rules: [{ id: 'x1', type: 'regex', value: '(a+)+$', enabled: true }],
  });
  const started = Date.now();
  const nasty = await opts4.evaluate("chrome.runtime.sendMessage({type:'wipeNow'})");
  const took = Date.now() - started;
  record('catastrophic pattern does not hang the worker', took < 5000, `${took} ms`);
  record('catastrophic pattern deletes nothing', nasty && nasty.deleted === 0, `deleted ${nasty?.deleted}`);
  const left4 = await historyUrls();
  record('the entry it would have matched is still there', left4.includes('https://regex.example/1'));
  await closePage(opts4.id);

  // --- 7. armed whole-history wipe still empties everything ----------------
  const opts5 = await scenario({
    urls: ['https://one.example/a', 'https://two.example/b', 'https://three.example/c'],
    rules: [{ id: 'r1', type: 'domain', value: 'never.matches', enabled: true }],
    wipeAllHistory: true,
  });
  const nuke = await opts5.evaluate("chrome.runtime.sendMessage({type:'wipeNow'})");
  const left5 = await historyUrls();
  record('armed wipe-all reports the real count', nuke && nuke.wipeAll === true && nuke.deleted >= 3, JSON.stringify(nuke));
  record('armed wipe-all leaves the database empty', left5.length === 0, `${left5.length} entries left`);
  await closePage(opts5.id);

  // --- 8. the PIN lock, in the real page ----------------------------------
  await resetStore();
  await setStore({ rules: [{ id: 'r1', type: 'domain', value: 'private.example', enabled: true }] });
  const opts6 = await openPage(`chrome-extension://${id}/src/options.html`);
  const pinned = await opts6.evaluate(`(async()=>{
    const hex=(b)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('2468'),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:1000,hash:'SHA-256'},key,256);
    const cur=(await chrome.storage.local.get('settings')).settings||{};
    await chrome.storage.local.set({settings:{...cur,advanced:true,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
    return 'ok';
  })()`);
  record('a PIN can be set on the real page', pinned === 'ok', pinned);

  const locked = await openPage(`chrome-extension://${id}/src/options.html`);
  const lockView = await locked.evaluate(`JSON.stringify({
    bodyLocked: document.body.classList.contains('locked'),
    rulesHidden: getComputedStyle(document.querySelector('.card.lockable')).display === 'none',
    rowsRendered: document.getElementById('rulesBody').children.length,
    unlockRowVisible: !document.getElementById('lockUnlockRow').classList.contains('hidden'),
    forgotVisible: !document.getElementById('lockForgotRow').classList.contains('hidden'),
    recoveryHidden: document.getElementById('lockRecoverRow').classList.contains('hidden')
  })`);
  const lv = JSON.parse(lockView);
  record('locked page hides the list sections', lv.bodyLocked && lv.rulesHidden, `rulesHidden=${lv.rulesHidden}`);
  record('locked page renders no rule rows at all', lv.rowsRendered === 0, `${lv.rowsRendered} rows in the DOM`);
  record('locked page offers the PIN box', lv.unlockRowVisible);
  record('locked page offers the way out', lv.forgotVisible && lv.recoveryHidden);

  const wrong = await locked.evaluate(`(async()=>{
    document.getElementById('lockPin').value='0000';
    document.getElementById('lockUnlock').click();
    await new Promise(r=>setTimeout(r,400));
    return document.getElementById('lockMsg').textContent;
  })()`);
  record('a wrong PIN is refused', /Wrong PIN/.test(String(wrong)), wrong);
  const stillLocked = await locked.evaluate("(async()=>(await chrome.storage.local.get('settings')).settings.lockEnabled)()");
  record('a wrong PIN changes nothing', stillLocked === true);

  const right = await locked.evaluate(`(async()=>{
    document.getElementById('lockPin').value='2468';
    document.getElementById('lockUnlock').click();
    await new Promise(r=>setTimeout(r,700));
    return JSON.stringify({
      locked: document.body.classList.contains('locked'),
      rows: document.getElementById('rulesBody').children.length,
      msg: document.getElementById('lockMsg').textContent,
      lockOn: (await chrome.storage.local.get('settings')).settings.lockEnabled
    });
  })()`);
  const rv = JSON.parse(right);
  record('the right PIN unlocks and shows the list', !rv.locked && rv.rows === 1, `${rv.rows} rule row(s)`);
  record('unlocking leaves the lock switched on', rv.lockOn === true, rv.msg);
  await closePage(locked.id);

  // --- 9. the forgotten-PIN way out, in the real page ----------------------
  const forgot = await openPage(`chrome-extension://${id}/src/options.html`);
  const recovery = await forgot.evaluate(`(async()=>{
    document.getElementById('lockForgot').click();
    await new Promise(r=>setTimeout(r,150));
    const lead = document.getElementById('lockRecoveryNote').textContent;
    const shown = !document.getElementById('lockRecoverRow').classList.contains('hidden');
    document.getElementById('lockRecovery').value='nope';
    document.getElementById('lockRecoverBtn').click();
    await new Promise(r=>setTimeout(r,400));
    const wrongMsg = document.getElementById('lockRecoveryNote').textContent;
    const survived = (await chrome.storage.local.get('settings')).settings.lockEnabled;
    return JSON.stringify({ lead, shown, wrongMsg, survived });
  })()`);
  const rc = JSON.parse(recovery);
  record('forgot-the-PIN explains itself', rc.shown && rc.lead.includes('lilbro'), rc.lead.slice(0, 60));
  record('a wrong word changes nothing', /not the word/i.test(rc.wrongMsg) && rc.survived === true, rc.wrongMsg);

  const wiped = await forgot.evaluate(`(async()=>{
    document.getElementById('lockRecovery').value='lilbro';
    document.getElementById('lockRecoverBtn').click();
    await new Promise(r=>setTimeout(r,1200));
    const local = await chrome.storage.local.get(null);
    return JSON.stringify({
      locked: document.body.classList.contains('locked'),
      lockOn: !!local.settings?.lockEnabled,
      hash: local.settings?.lockHash || '',
      rules: (await chrome.storage.sync.get('rulesMeta')).rulesMeta?.count ?? -1,
      localRules: (local.rulesMirror || []).length,
      msg: document.getElementById('lockMsg').textContent
    });
  })()`);
  const wr = JSON.parse(wiped);
  record('the word removes the PIN', wr.lockOn === false && wr.hash === '', `lockEnabled=${wr.lockOn}`);
  record('the word wipes the saved list', wr.rules === 0 && wr.localRules === 0, `sync count=${wr.rules}`);
  record('the page comes back with everything visible', wr.locked === false);
  await closePage(forgot.id);

  // --- 10. the popup, in the real browser ---------------------------------
  const dialogs = [];
  await resetStore();
  await setStore({
    rules: [{ id: 'p1', type: 'domain', value: 'popup.example', enabled: true }],
    settings: {
      enabled: true,
      mode: 'startup',
      sweepExistingOnStartup: false,
      notifyOnWipe: false,
      listMode: 'block',
      wipeAllHistory: false,
    },
  });
  await clearHistory();
  await seed(['https://popup.example/one', 'https://popup.example/two', 'https://safe.example/three']);
  await sleep(400);
  await ev('chrome.storage.local.set({pending: []})');

  const pop = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const view = JSON.parse(
    await pop.evaluate(`JSON.stringify({
      title: document.title,
      version: document.getElementById('version').textContent.trim(),
      status: document.getElementById('status').textContent.trim(),
      dot: document.getElementById('dot').className,
      scopeList: document.getElementById('scopeList').checked,
      scopeAll: document.getElementById('scopeAll').checked,
      wipeBtn: document.getElementById('wipeBtn').textContent.trim(),
      addDomain: document.getElementById('addDomainBtn').textContent.trim(),
      lockCardHidden: document.getElementById('lockCard').classList.contains('hidden'),
      verdict: document.getElementById('siteVerdict').textContent.trim(),
      verdictClass: document.getElementById('siteVerdict').className,
      sitePreview: document.getElementById('sitePreview').textContent.trim(),
      switchState: document.getElementById('toggleBtn').getAttribute('aria-checked'),
      extraLine: document.getElementById('extraLine').textContent.trim(),
      extraRowHidden: document.getElementById('extraRow').classList.contains('hidden')
    })`)
  );
  record('popup renders with its version', view.version.includes(m.version), `${view.title} / ${view.version}`);
  record('popup shows the active state', view.status === 'Active' && view.dot === 'dot', `${view.status} (${view.dot})`);
  record('popup starts on "only my list"', view.scopeList === true && view.scopeAll === false, view.wipeBtn);
  record('popup shows a lock card only when a PIN exists', view.lockCardHidden === true);
  // The popup itself runs in a tab here, so the tab it looks at has no wipeable
  // site: the preview line carries that fact, and the verdict stays empty rather
  // than printing the same sentence a second time in a louder weight.
  record(
    'popup says what happens to the tab it is looking at',
    /no wipeable site/.test(view.sitePreview) &&
      view.verdict === '' &&
      /\bverdict\b/.test(view.verdictClass),
    `${view.sitePreview} / verdict "${view.verdict}" (${view.verdictClass})`
  );
  record('the switch carries the state it controls', view.switchState === 'true', String(view.switchState));
  record(
    'the popup says what is not being cleared',
    /History only/.test(view.extraLine) && view.extraRowHidden === true,
    view.extraLine
  );

  // The compact/classic switch was removed in 1.4.0, and the popup verdict replaced
  // it. Both of the controls it used are gone rather than merely hidden.
  const leftovers = JSON.parse(
    await pop.evaluate(`JSON.stringify({
      layoutBtn: !!document.getElementById('layoutBtn'),
      moreBtn: !!document.getElementById('moreBtn'),
      bodyLayout: document.body.className
    })`)
  );
  record(
    'the compact/classic switch is gone, not just hidden',
    leftovers.layoutBtn === false && leftovers.moreBtn === false && !/layout-/.test(leftovers.bodyLayout),
    leftovers.bodyLayout
  );

  // The extra clear, driven from the popup, against the real browser.
  await setStore({
    settings: {
      enabled: true,
      mode: 'startup',
      sweepExistingOnStartup: false,
      notifyOnWipe: false,
      listMode: 'block',
      wipeAllHistory: false,
      extraCache: true,
      extraCookies: true,
      extraSince: 'hour',
      extraTrigger: 'manual',
    },
  });
  const popExtra = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const extraView = JSON.parse(
    await popExtra.evaluate(`JSON.stringify({
      rowShown: !document.getElementById('extraRow').classList.contains('hidden'),
      line: document.getElementById('extraLine').textContent.trim()
    })`)
  );
  record(
    'the extra clear announces itself in the popup',
    extraView.rowShown && /Cache/.test(extraView.line) && /Cookies/.test(extraView.line),
    extraView.line.slice(0, 70)
  );
  const historyBeforeExtra = (await historyUrls()).length;
  const extraReply = await popExtra.evaluate(`new Promise((res)=>{
    document.getElementById('extraBtn').click();
    const started = Date.now();
    const t = setInterval(()=>{
      const m = document.getElementById('wipeMsg').textContent.trim();
      if (m && !/Clearing/.test(m)) { clearInterval(t); res(m); }
      else if (Date.now() - started > 20000) { clearInterval(t); res('timeout: ' + m); }
    }, 60);
  })`);
  record(
    'pressing it reports a real clear, with no invented count',
    /Cleared .*Cache/.test(String(extraReply)) && /no count/i.test(String(extraReply)),
    String(extraReply).slice(0, 80)
  );
  record(
    'and it deletes no history',
    (await historyUrls()).length === historyBeforeExtra,
    `${(await historyUrls()).length} of ${historyBeforeExtra} still there`
  );
  await closePage(popExtra.id);

  const first = JSON.parse(
    await pop.evaluate(`(async()=>{
      document.getElementById('wipeBtn').click();
      await new Promise(r=>setTimeout(r,300));
      return JSON.stringify({
        label: document.getElementById('wipeBtn').textContent.trim(),
        msg: document.getElementById('wipeMsg').textContent.trim()
      });
    })()`)
  );
  const afterFirst = await historyUrls();
  record(
    'one click on Wipe now wipes nothing',
    afterFirst.some((u) => u.includes('popup.example')),
    `${afterFirst.length} entries still there`
  );
  record(
    'it asks for a second click instead',
    first.label !== view.wipeBtn && first.msg.length > 0,
    `"${first.label}" / ${first.msg.slice(0, 40)}`
  );
  await pop.evaluate("document.getElementById('wipeBtn').click()");
  await sleep(800);
  const afterSecond = await historyUrls();
  record(
    'the second click wipes exactly the matches',
    !afterSecond.some((u) => u.includes('popup.example')) && afterSecond.some((u) => u.includes('safe.example')),
    afterSecond.join(' ')
  );
  await closePage(pop.id);

  await setStore({
    settings: {
      enabled: true,
      mode: 'startup',
      sweepExistingOnStartup: false,
      notifyOnWipe: false,
      listMode: 'block',
      wipeAllHistory: true,
    },
  });
  await clearHistory();
  await seed(['https://gone.example/a', 'https://gone.example/b']);
  await sleep(400);
  await ev('chrome.storage.local.set({pending: []})');
  const pop2 = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const armedView = JSON.parse(
    await pop2.evaluate(`JSON.stringify({
      status: document.getElementById('status').textContent.trim(),
      dot: document.getElementById('dot').className,
      wipeBtn: document.getElementById('wipeBtn').textContent.trim(),
      warn: document.getElementById('wipeAllWarn').textContent.trim(),
      scopeAll: document.getElementById('scopeAll').checked
    })`)
  );
  record(
    'popup shows the armed state in red',
    /Full wipe is on/.test(armedView.status) && /danger/.test(armedView.dot),
    `${armedView.status} (${armedView.dot})`
  );
  record(
    'the armed button says what it will do',
    /ALL history now/.test(armedView.wipeBtn) && armedView.scopeAll === true,
    armedView.wipeBtn
  );
  record(
    'the armed state is explained',
    /not just your rules/.test(armedView.warn) && !/never touched/i.test(armedView.warn),
    armedView.warn
  );

  const gate = JSON.parse(
    await pop2.evaluate(`(async()=>{
      document.getElementById('wipeBtn').click();
      await new Promise(r=>setTimeout(r,300));
      return JSON.stringify({
        row: !document.getElementById('phraseRow').classList.contains('hidden'),
        msg: document.getElementById('wipeMsg').textContent.trim()
      });
    })()`)
  );
  const afterGate = await historyUrls();
  record('armed wipe demands the typed phrase first', gate.row && /WIPE ALL/.test(gate.msg), gate.msg.slice(0, 40));
  record('and deletes nothing while it waits', afterGate.length >= 2, `${afterGate.length} entries intact`);

  await pop2.evaluate(
    "document.getElementById('confirmPhrase').value='WIPE'; document.getElementById('confirmPhraseBtn').click()"
  );
  await sleep(250);
  const afterWrongPhrase = await historyUrls();
  record('a wrong phrase arms nothing', afterWrongPhrase.length >= 2, `${afterWrongPhrase.length} entries intact`);

  await pop2.evaluate(
    "document.getElementById('confirmPhrase').value='WIPE ALL'; document.getElementById('confirmPhraseBtn').click()"
  );
  await sleep(250);
  const afterPhrase = await historyUrls();
  record('the phrase alone still deletes nothing', afterPhrase.length >= 2, `${afterPhrase.length} entries intact`);
  await pop2.evaluate("document.getElementById('wipeBtn').click()");
  await sleep(900);
  const afterNuke = await historyUrls();
  record('phrase plus the confirming click empties the history', afterNuke.length === 0, `${afterNuke.length} entries left`);
  await closePage(pop2.id);

  // Switching to "everything, always" has to pass a question.
  await setStore({
    settings: {
      enabled: true,
      mode: 'startup',
      sweepExistingOnStartup: false,
      notifyOnWipe: false,
      listMode: 'block',
      wipeAllHistory: false,
    },
  });
  const pop3 = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const dialogsBefore = dialogs.length;
  await pop3.evaluate("document.getElementById('scopeAll').click()");
  await sleep(500);
  const armedAfterDismiss = await pop3.evaluate(
    "(async()=>(await chrome.storage.local.get('settings')).settings.wipeAllHistory)()"
  );
  const scopeBack = await pop3.evaluate("document.getElementById('scopeAll').checked");
  record(
    'switching to "everything, always" asks first',
    dialogs.length === dialogsBefore + 1 && /whole history/i.test(String(dialogs[dialogs.length - 1])),
    String(dialogs[dialogs.length - 1]).slice(0, 60)
  );
  record(
    'dismissing that question cannot arm it',
    armedAfterDismiss === false && scopeBack === false,
    `wipeAllHistory=${armedAfterDismiss}, radio=${scopeBack}`
  );
  await closePage(pop3.id);

  // Keep-list mode renames the popup controls rather than moving them.
  await setStore({
    rules: [{ id: 'k1', type: 'domain', value: 'keep.example', enabled: true }],
    settings: {
      enabled: true,
      mode: 'startup',
      sweepExistingOnStartup: false,
      notifyOnWipe: false,
      listMode: 'allow',
      wipeAllHistory: false,
    },
  });
  const pop4 = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const keepView = JSON.parse(
    await pop4.evaluate(`JSON.stringify({
      status: document.getElementById('status').textContent.trim(),
      addDomain: document.getElementById('addDomainBtn').textContent.trim(),
      addUrl: document.getElementById('addUrlBtn').textContent.trim(),
      warn: document.getElementById('wipeAllWarn').textContent.trim()
    })`)
  );
  record(
    'keep mode says what it is doing',
    /keep list/i.test(keepView.status) &&
      /Keep this site/.test(keepView.addDomain) &&
      /Keep this exact page/.test(keepView.addUrl),
    `${keepView.status} / "${keepView.addDomain}"`
  );
  record(
    'keep mode warns that everything else goes',
    /not on your list/i.test(keepView.warn),
    keepView.warn.slice(0, 55)
  );
  await closePage(pop4.id);

  // With a PIN set, the popup hides the same sections the options page hides.
  await ev(`(async()=>{
    const hex=(b)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('1357'),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:1000,hash:'SHA-256'},key,256);
    const cur=(await chrome.storage.local.get('settings')).settings||{};
    await chrome.storage.local.set({settings:{...cur,advanced:true,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
    return 'ok';
  })()`);
  const pop5 = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  const lockView2 = JSON.parse(
    await pop5.evaluate(`JSON.stringify({
      bodyLocked: document.body.classList.contains('locked'),
      card: !document.getElementById('lockCard').classList.contains('hidden'),
      forgot: !document.getElementById('forgotRow').classList.contains('hidden'),
      recover: document.getElementById('recoverRow').classList.contains('hidden'),
      addHidden: getComputedStyle(document.getElementById('addDomainBtn').closest('.card')).display === 'none',
      verdict: document.getElementById('siteVerdict').textContent.trim(),
      status: document.getElementById('status').textContent.trim()
    })`)
  );
  record('popup shows the lock card when a PIN exists', lockView2.card && lockView2.bodyLocked, lockView2.status);
  record('popup lock offers the way out as well', lockView2.forgot === true && lockView2.recover === true);
  // Adding is allowed while the lock is on: the button names no site, so it gives
  // nothing away. What stays hidden is anything that lists what is being cleaned.
  record('popup can still add while locked', lockView2.addHidden === false);
  // The verdict names what happens to this tab, so it says nothing while locked.
  record('popup says nothing about the tab while locked', lockView2.verdict === '', `"${lockView2.verdict}"`);
  await closePage(pop5.id);

  // --- 11. while the lock is on, nothing on either page names the list --------
  // A rule with a name worth hiding, then a sweep of everything a page can put on
  // screen: body text, every title/placeholder/value/aria-label, and the lists.
  const SECRET = 'hidden-secret.example';
  // The rule is written the way readRules() looks for it: the list lives in sync
  // storage (with the local mirror), so a local-only write would be shadowed.
  const seedResult = await ev(`(async()=>{
    try {
      const rule = { id: 'sec1', type: 'domain', value: ${JSON.stringify(SECRET)}, enabled: true };
      await chrome.storage.sync.set({ rulesMeta: { chunks: 1, count: 1, at: Date.now() }, rulesChunk0: [rule] });
      await chrome.storage.local.set({ rules: [rule], rulesMirror: [rule] });
      const sync = await chrome.storage.sync.get(['rulesMeta']);
      const local = await chrome.storage.local.get(['rules']);
      const settings = (await chrome.storage.local.get('settings')).settings || {};
      return JSON.stringify({
        syncCount: sync.rulesMeta && sync.rulesMeta.count,
        local: local.rules && local.rules[0] && local.rules[0].value,
        lock: !!settings.lockEnabled,
      });
    } catch (e) {
      return JSON.stringify({ error: String(e && e.message ? e.message : e) });
    }
  })()`);
  const seededView = JSON.parse(String(seedResult));
  record(
    'the seed rule is in storage, and the PIN lock is still on',
    seededView.syncCount === 1 && seededView.local === SECRET && seededView.lock === true,
    String(seedResult).slice(0, 110)
  );

  const leakSweep = async (page, label) => {
    const raw = await page.evaluate(`(()=>{
      const secret = ${JSON.stringify(SECRET)};
      const bad = [];
      if ((document.body.innerText || '').includes(secret)) bad.push('body text');
      for (const el of document.querySelectorAll('*')) {
        for (const attr of ['title', 'placeholder', 'value', 'aria-label', 'content']) {
          const v = el.getAttribute ? el.getAttribute(attr) : null;
          if (v && String(v).includes(secret)) bad.push(el.tagName + '[' + attr + ']');
        }
      }
      const rules = document.getElementById('rulesBody');
      if (rules && rules.children.length) bad.push('rule rows still in the DOM: ' + rules.children.length);
      const log = document.getElementById('logList');
      if (log && (log.innerText || '').includes(secret)) bad.push('log text');
      return JSON.stringify({ bad, locked: document.body.classList.contains('locked') });
    })()`);
    const r = JSON.parse(raw);
    record(
      `${label} while locked: the list is nowhere on the page`,
      r.locked === true && r.bad.length === 0,
      r.bad.join(', ') || 'clean'
    );
  };

  const popLocked = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  await leakSweep(popLocked, 'popup');
  await closePage(popLocked.id);

  const optLocked = await openPage(`chrome-extension://${id}/src/options.html`);
  await leakSweep(optLocked, 'options');

  // Adding while the lock is on must not name what was added. The confirmation
  // reads the bare word, and the tester stays quiet, since it answers with the
  // name of the rule that matched.
  const NEW = 'another-secret.example';
  const addWhileLocked = JSON.parse(
    await optLocked.evaluate(`(async()=>{
      document.getElementById('ruleValue').value = ${JSON.stringify(NEW)};
      document.getElementById('addBtn').click();
      await new Promise(r=>setTimeout(r,700));
      const testUrl = document.getElementById('testUrl');
      testUrl.value = 'https://' + ${JSON.stringify(NEW)} + '/x';
      testUrl.dispatchEvent(new Event('input'));
      await new Promise(r=>setTimeout(r,400));
      return JSON.stringify({
        msg: document.getElementById('addMsg').textContent.trim(),
        testOut: document.getElementById('testOut').textContent.trim(),
        namesIt: (document.body.innerText || '').includes(${JSON.stringify(NEW)}),
        testDisabled: testUrl.disabled,
        rows: document.getElementById('rulesBody').children.length
      });
    })()`)
  );
  record(
    'adding while locked names nothing, and the tester stays quiet',
    addWhileLocked.namesIt === false &&
      /^Added\.?$/.test(addWhileLocked.msg) &&
      addWhileLocked.testOut === '' &&
      addWhileLocked.testDisabled === true,
    JSON.stringify(addWhileLocked)
  );

  // The same sweep, after the right PIN: it has to find the rule, or it proves nothing.
  const shown = await optLocked.evaluate(`(async()=>{
    document.getElementById('lockPin').value='1357';
    document.getElementById('lockUnlock').click();
    await new Promise(r=>setTimeout(r,1200));
    return JSON.stringify({
      locked: document.body.classList.contains('locked'),
      rows: document.getElementById('rulesBody').children.length,
      named: (document.body.innerText || '').includes(${JSON.stringify(SECRET)})
    });
  })()`);
  const sv = JSON.parse(shown);
  record(
    'the same page shows the list once the PIN is in, so the sweep is not vacuous',
    // Two rules by now: the seeded one, and the one added while the lock was on.
    sv.locked === false && sv.rows >= 2 && sv.named === true,
    `${sv.rows} rule row(s), named=${sv.named}`
  );
  await closePage(optLocked.id);

  // --- 12. a profile that came from 1.3.5, opened by this build ---------------
  // The blob is written the way 1.3.5 wrote it: settings in local, the rule list in
  // sync chunks, and no local mirror, because a machine that synced from another one
  // never wrote one. Then both pages have to come up showing the user's own choices
  // rather than the defaults. mode is the legacy 'onclose', which the page is meant
  // to move to the next start, since that is what it did in practice.
  await resetStore();
  await ev(`(async()=>{
    await chrome.storage.local.set({
      settings: {
        enabled: true, mode: 'onclose', sweepExistingOnStartup: false, notifyOnWipe: false,
        logEnabled: true, logLimit: 200, includeSubdomainsDefault: true, wipeAllHistory: false,
        listMode: 'allow', lockEnabled: false, lockHash: '', lockSalt: '', lockIterations: 0,
        extraCache: true, extraCookies: false, extraDownloads: false, extraFormData: false,
        extraSince: 'week', extraTrigger: 'manual', popupLayout: 'classic', advanced: true,
        preset: 'custom', cookieKeep: ['keepme.example'], cookiesOnStart: false,
        cookiesOnTabClose: false, theme: 'slate'
      },
      stats: { wipedTotal: 4821, lastRunAt: 1758000006000, lastRunCount: 37, lastRunPhase: 'manual' },
      log: [{ url: 'https://auction.example/item/9', rule: 'auction', at: 1758000005000 }],
      pending: []
    });
    await chrome.storage.sync.set({
      rulesMeta: { chunks: 1, count: 2, at: 1758000002000 },
      rulesChunk0: [
        { id: 'r1', type: 'domain', value: 'embarrassing-shop.example', includeSubdomains: true, enabled: true, createdAt: 1758000000000 },
        { id: 'r2', type: 'keyword', value: 'auction', wholeWord: false, enabled: false, createdAt: 1758000001000 }
      ]
    });
    return 'seeded';
  })()`);

  const upPage = await openPage(`chrome-extension://${id}/src/options.html`);
  const afterUpgrade = JSON.parse(
    await upPage.evaluate(`(async()=>{
      await new Promise(r=>setTimeout(r,900));
      const mirror = (await chrome.storage.local.get('rulesMirror')).rulesMirror || [];
      const mode = (await chrome.storage.local.get('settings')).settings.mode;
      const radios = [...document.querySelectorAll('input[name="mode"]')];
      return JSON.stringify({
        theme: document.documentElement.dataset.theme,
        radioChecked: (radios.find(r=>r.checked) || {}).value || '',
        modeInStorage: mode,
        rows: document.getElementById('rulesBody').children.length,
        named: (document.body.innerText || '').includes('embarrassing-shop.example'),
        sweep: document.getElementById('sweep').checked,
        notify: document.getElementById('notify').checked,
        cache: document.getElementById('extraCache').checked,
        keepOnly: document.getElementById('keepOnly').checked,
        mirrorCount: Array.isArray(mirror) ? mirror.length : -1,
        heading: (document.querySelector('h2') || {}).textContent || ''
      });
    })()`)
  );
  record(
    'a 1.3.5 profile keeps its theme through the update',
    afterUpgrade.theme === 'slate',
    afterUpgrade.theme
  );
  record(
    'the legacy close trigger moves to the next start, in storage too',
    afterUpgrade.radioChecked === 'startup' && afterUpgrade.modeInStorage === 'startup',
    `ui ${afterUpgrade.radioChecked} / storage ${afterUpgrade.modeInStorage}`
  );
  record(
    'its rule list is read out of sync and shown',
    afterUpgrade.rows === 2 && afterUpgrade.named === true,
    `${afterUpgrade.rows} row(s), named=${afterUpgrade.named}`
  );
  record(
    'the list gets a local mirror it never had, so sync can go away later',
    afterUpgrade.mirrorCount === 2,
    String(afterUpgrade.mirrorCount)
  );
  record(
    'its own switches survive: sweep off, notify off, cache on, keep mode on',
    afterUpgrade.sweep === false &&
      afterUpgrade.notify === false &&
      afterUpgrade.cache === true &&
      afterUpgrade.keepOnly === true,
    `sweep=${afterUpgrade.sweep} notify=${afterUpgrade.notify} cache=${afterUpgrade.cache} keep=${afterUpgrade.keepOnly}`
  );
  record(
    'a profile with no language key falls back to English, not to a blank page',
    /When should it clean/i.test(afterUpgrade.heading),
    afterUpgrade.heading.trim()
  );
  await closePage(upPage.id);

  // --- 13. optional screenshots: the compact popup, the classic one, the options --
  // node tools/live_probe.mjs <port> <browser> <output-dir> [en|pl] [theme]
  const shotsDir = process.argv[4];
  // The language for the screenshots. The checks above run pinned to English; the
  // shots follow this, so the same run can produce the Polish store images.
  const shotLang = process.argv[5] || 'en';
  // The theme for the screenshots, so a run can photograph any of the eight.
  const shotTheme = process.argv[6] || 'auto';
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await resetStore();
    await setStore({
      rules: [
        { id: 's1', type: 'domain', value: 'linkedin.com', includeSubdomains: true, enabled: true },
        { id: 's2', type: 'keyword', value: 'auction', enabled: true },
      ],
      settings: {
        enabled: true,
        mode: 'realtime',
        lang: shotLang,
        theme: shotTheme,
        sweepExistingOnStartup: true,
        notifyOnWipe: false,
        listMode: 'block',
        wipeAllHistory: false,
        extraCache: true,
        extraCookies: false,
      },
      stats: { wipedTotal: 4821, lastRunAt: Date.now() - 3600000, lastRunCount: 37, lastRunPhase: 'manual' },
    });

    const shoot = async (page, file, width, height, full, scale = 2) => {
      await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
      await sleep(400);
      const r = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: !!full,
      });
      const data = r && r.result && r.result.data;
      if (!data) {
        record(`screenshot ${file}`, false, JSON.stringify(r).slice(0, 140));
        return;
      }
      const out = path.join(shotsDir, file);
      writeFileSync(out, Buffer.from(data, 'base64'));
      record(`screenshot ${file}`, true, out);
    };

    // The store takes 1280x800 or 640x400. The pages are shot at 1280x800 with
    // scale 1; the popup is a 360px panel, so it is shot at 2x and put on that
    // canvas afterwards, which is what tools/make_shot_sheets.mjs does.
    const shotPopup = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
    await shoot(shotPopup, 'popup-compact.png', 360, 520, false);
    await closePage(shotPopup.id);

    const shotOptions = await openPage(`chrome-extension://${id}/src/options.html`);
    await shoot(shotOptions, 'options.png', 1280, 800, false, 1);
    await shotOptions.evaluate('window.scrollTo(0, 900)');
    await sleep(400);
    await shoot(shotOptions, 'options-lower.png', 1280, 800, false, 1);
    await closePage(shotOptions.id);

    // The same options page with a PIN set, which is what the lock looks like.
    await ev(`(async()=>{
      const hex=(b)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
      const salt=crypto.getRandomValues(new Uint8Array(16));
      const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('2468'),'PBKDF2',false,['deriveBits']);
      const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:1000,hash:'SHA-256'},key,256);
      const cur=(await chrome.storage.local.get('settings')).settings||{};
      await chrome.storage.local.set({settings:{...cur,advanced:true,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
      return 'ok';
    })()`);
    const shotLocked = await openPage(`chrome-extension://${id}/src/options.html`);
    await shoot(shotLocked, 'options-locked.png', 1280, 800, false, 1);
    await closePage(shotLocked.id);
  }
} catch (e) {
  record('probe ran to the end', false, String(e.message || e));
} finally {
  try {
    child?.kill();
  } catch {}
  await sleep(900);
  try {
    child?.kill('SIGKILL');
  } catch {}
  try {
    rmSync(stage, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${exe.split(/[\\/]/).pop()}`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
}
process.exit(failed.length ? 1 : 0);
