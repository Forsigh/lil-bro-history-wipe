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
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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
      '--window-size=900,700',
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
  record('version is 1.1.1', m.version === '1.1.1', m.version);
  record(
    'permission set unchanged',
    JSON.stringify([...m.permissions].sort()) ===
      JSON.stringify(['activeTab', 'contextMenus', 'history', 'notifications', 'storage']),
    m.permissions.join(', ')
  );

  // --- 2. the permission surface, in the real browser -----------------------
  const surface = await ev(
    'JSON.stringify({browsingData: typeof chrome.browsingData, cookies: typeof chrome.cookies, downloads: typeof chrome.downloads, sessions: typeof chrome.sessions, search: typeof chrome.history.search, del: typeof chrome.history.deleteUrl, delAll: typeof chrome.history.deleteAll})'
  );
  const s = JSON.parse(surface);
  record('cookies API absent (no permission)', s.cookies === 'undefined', `typeof chrome.cookies = ${s.cookies}`);
  record('browsingData API absent (no permission)', s.browsingData === 'undefined', s.browsingData);
  record('downloads API absent', s.downloads === 'undefined', s.downloads);
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
    return openPage(`chrome-extension://${id}/options.html`);
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
  const opts6 = await openPage(`chrome-extension://${id}/options.html`);
  const pinned = await opts6.evaluate(`(async()=>{
    const hex=(b)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('2468'),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:1000,hash:'SHA-256'},key,256);
    const cur=(await chrome.storage.local.get('settings')).settings||{};
    await chrome.storage.local.set({settings:{...cur,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
    return 'ok';
  })()`);
  record('a PIN can be set on the real page', pinned === 'ok', pinned);

  const locked = await openPage(`chrome-extension://${id}/options.html`);
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
  const forgot = await openPage(`chrome-extension://${id}/options.html`);
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

  const pop = await openPage(`chrome-extension://${id}/popup.html`, dialogs);
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
      lockCardHidden: document.getElementById('lockCard').classList.contains('hidden')
    })`)
  );
  record('popup renders with its version', /1\.1\.1/.test(view.version), `${view.title} / ${view.version}`);
  record('popup shows the active state', view.status === 'Active' && view.dot === 'dot', `${view.status} (${view.dot})`);
  record('popup starts on "only my list"', view.scopeList === true && view.scopeAll === false, view.wipeBtn);
  record('popup shows a lock card only when a PIN exists', view.lockCardHidden === true);

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
  const pop2 = await openPage(`chrome-extension://${id}/popup.html`, dialogs);
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
    /Armed/.test(armedView.status) && /danger/.test(armedView.dot),
    `${armedView.status} (${armedView.dot})`
  );
  record(
    'the armed button says what it will do',
    /ALL history now/.test(armedView.wipeBtn) && armedView.scopeAll === true,
    armedView.wipeBtn
  );
  record(
    'the armed state is explained, cookies included',
    /entire history/.test(armedView.warn) && /cookies/i.test(armedView.warn),
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
  const pop3 = await openPage(`chrome-extension://${id}/popup.html`, dialogs);
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
  const pop4 = await openPage(`chrome-extension://${id}/popup.html`, dialogs);
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
    /everything/i.test(keepView.warn) && /cookies/i.test(keepView.warn),
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
    await chrome.storage.local.set({settings:{...cur,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
    return 'ok';
  })()`);
  const pop5 = await openPage(`chrome-extension://${id}/popup.html`, dialogs);
  const lockView2 = JSON.parse(
    await pop5.evaluate(`JSON.stringify({
      bodyLocked: document.body.classList.contains('locked'),
      card: !document.getElementById('lockCard').classList.contains('hidden'),
      forgot: !document.getElementById('forgotRow').classList.contains('hidden'),
      recover: document.getElementById('recoverRow').classList.contains('hidden'),
      addHidden: getComputedStyle(document.getElementById('addDomainBtn').closest('.card')).display === 'none',
      status: document.getElementById('status').textContent.trim()
    })`)
  );
  record('popup shows the lock card when a PIN exists', lockView2.card && lockView2.bodyLocked, lockView2.status);
  record('popup lock offers the way out as well', lockView2.forgot === true && lockView2.recover === true);
  record('popup hides the list sections while locked', lockView2.addHidden === true);
  await closePage(pop5.id);
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
