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
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  // The manifest version has to be a real number, and the table in docs/VERSIONS.md
  // must not be ahead of it. This check used to pin a literal, so it failed on every
  // bump and taught nobody anything.
  const tableVersions = [
    ...readFileSync(new URL('../docs/VERSIONS.md', import.meta.url), 'utf8').matchAll(
      /^\|\s*(\d+\.\d+\.\d+)\s*\|/gm
    ),
  ].map((x) => x[1]);
  const vNums = (s) => s.split('.').map(Number);
  const vNewer = (a, b) => {
    const [x, y] = [vNums(a), vNums(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const newestOnTable = tableVersions.reduce((a, b) => (vNewer(a, b) ? a : b), '0.0.0');
  record(
    'version is a real number, and the released table is not ahead of it',
    /^\d+\.\d+\.\d+$/.test(m.version) && !vNewer(newestOnTable, m.version),
    `${m.version}, newest in VERSIONS.md ${newestOnTable}`
  );
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
      rules: (await chrome.storage.local.get('rulesMeta')).rulesMeta?.count ?? -1,
      localRules: (local.rulesMirror || []).length,
      msg: document.getElementById('lockMsg').textContent
    });
  })()`);
  const wr = JSON.parse(wiped);
  record('the word removes the PIN', wr.lockOn === false && wr.hash === '', `lockEnabled=${wr.lockOn}`);
  record('the word wipes the saved list', wr.rules === 0 && wr.localRules === 0, `sync count=${wr.rules}`);
  record('the page comes back with everything visible', wr.locked === false);
  await closePage(forgot.id);

  // --- a profile with nothing stored yet ------------------------------------
  // Everything below seeds storage before it opens a page, so the state a fresh install
  // really starts in was never exercised: no rules, no settings, no log. That is what a
  // new user gets, and the state a page is most likely to break on.
  {
    await resetStore();

    const fresh = await openPage(`chrome-extension://${id}/src/popup.html`);
    await sleep(600);
    const pop = JSON.parse(
      await fresh.evaluate(`JSON.stringify({
        status: document.getElementById('status').textContent.trim(),
        dot: document.getElementById('dot').className,
        versionLine: !!document.getElementById('version'),
        noteShown: !document.getElementById('newInThisVersion').classList.contains('hidden'),
        message: document.getElementById('wipeMsg').textContent.trim()
      })`)
    );
    await closePage(fresh.id);

    const opts = await openPage(`chrome-extension://${id}/src/options.html`);
    await sleep(800);
    const page = JSON.parse(
      await opts.evaluate(`JSON.stringify({
        state: document.getElementById('stateText').textContent.trim(),
        dot: document.getElementById('stateDot').className,
        rules: document.getElementById('rulesBody').textContent.trim().length
      })`)
    );
    await closePage(opts.id);

    record(
      'both pages start on a profile with nothing in it',
      pop.status === 'Active' && page.state.startsWith('Active'),
      `popup "${pop.status}" + "${pop.message}", settings "${page.state}"`
    );
    record(
      'a fresh install gets no note about what changed, and no version line',
      pop.noteShown === false && pop.versionLine === false,
      `note visible: ${pop.noteShown}, version line present: ${pop.versionLine}`
    );
  }

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
      versionLine: !!document.getElementById('version'),
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
  record('popup renders, and prints no version number on it', view.title === 'Lil Bro' && view.versionLine === false, `${view.title}, version line present: ${view.versionLine}`);

  // The note about what changed appears once per version: with an older value stored it
  // is there, and its button puts it away. A fresh install was checked above and sees
  // nothing, because nothing changed for somebody who was not here for the old build.
  await ev(`chrome.storage.local.set({ whatsNewSeen: '1.0.0' })`);
  const popNew = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
  await sleep(700);
  const changeNote = JSON.parse(
    await popNew.evaluate(`JSON.stringify({
      shown: !document.getElementById('newInThisVersion').classList.contains('hidden'),
      text: document.getElementById('newInThisVersion').textContent.trim().slice(0, 34)
    })`)
  );
  await popNew.evaluate(`document.getElementById('whatsNewOk').click()`);
  await sleep(250);
  const afterOk = await popNew.evaluate(`document.getElementById('newInThisVersion').classList.contains('hidden')`);
  record(
    'the note about what changed shows once per version, and its button puts it away',
    changeNote.shown === true && afterOk === true,
    `visible: ${changeNote.shown}, hidden after the button: ${afterOk}, text: "${changeNote.text}…"`
  );
  await closePage(popNew.id);

  // Three tabs, one door open at a time. What has to hold: the page opens on the
  // day-to-day tab, that tab holds a small fraction of the controls the page owns, and
  // the tab in front is the only panel on screen.
  const optsAdv = await openPage(`chrome-extension://${id}/src/options.html`);
  await sleep(800);
  const tabs = JSON.parse(
    await optsAdv.evaluate(`JSON.stringify({
      names: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
      selected: [...document.querySelectorAll('.tab')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id),
      shown: [...document.querySelectorAll('.panel')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.id),
      open: document.querySelectorAll('.panel:not(.hidden) button, .panel:not(.hidden) input, .panel:not(.hidden) select, .panel:not(.hidden) textarea').length,
      total: document.querySelectorAll('button, input, select, textarea').length,
      paint: [...document.querySelectorAll('.tab')].map((t) => {
        const cs = getComputedStyle(t);
        return t.id.replace('tab', '') + ' bg:' + cs.backgroundColor + ' img:' + (cs.backgroundImage === 'none' ? '-' : cs.backgroundImage.slice(0, 40)) + ' fg:' + cs.color;
      }).join(' || ') + ' strip:' + getComputedStyle(document.querySelector('.tabs')).backgroundColor,
    })`)
  );
  record(
    'the settings page opens on the day-to-day tab and nowhere else',
    tabs.selected.length === 1 && tabs.selected[0] === 'tabCleaning' && tabs.shown.length === 1 && tabs.shown[0] === 'panelCleaning',
    `tabs ${tabs.names.join(' | ')}, selected ${tabs.selected.join(',')}, on screen ${tabs.shown.join(',')} | ${tabs.paint}`
  );
  record(
    'the tab in front holds a fraction of the controls the page owns',
    tabs.open >= 8 && tabs.open <= 30 && tabs.total - tabs.open > 20,
    `${tabs.open} controls on this tab, ${tabs.total} on the page`
  );
  await closePage(optsAdv.id);
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
  
  // A confirmation you cannot leave without a mouse is not a confirmation. Escape
  // closes the open row, arms nothing, and hands the keyboard back to the button.
  const escaped = JSON.parse(
    await pop2.evaluate(`(() => {
      const input = document.getElementById('confirmPhrase');
      input.focus();
      const focusedBefore = document.activeElement.id;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return JSON.stringify({
        focusedBefore,
        rowHidden: document.getElementById('phraseRow').classList.contains('hidden'),
        focusedAfter: document.activeElement.id
      });
    })()`)
  );
  record(
    'escape leaves the confirmation and hands the keyboard back',
    escaped.focusedBefore === 'confirmPhrase' &&
      escaped.rowHidden === true &&
      escaped.focusedAfter === 'wipeBtn',
    `${escaped.focusedBefore} -> ${escaped.focusedAfter}, row hidden: ${escaped.rowHidden}`
  );
  // Escape must leave nothing armed, so the next click starts at step one again
  // instead of completing a confirmation the user walked away from.
  await pop2.evaluate("document.getElementById('wipeBtn').click()");
  await sleep(250);
  const afterEscape = await historyUrls();
  const rowBack = await pop2.evaluate("!document.getElementById('phraseRow').classList.contains('hidden')");
  record(
    'and escape arms nothing, so the next click starts over',
    rowBack === true && afterEscape.length >= 2,
    `row back: ${rowBack}, ${afterEscape.length} entries intact`
  );
  
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
      note: document.getElementById('lockNote').textContent.trim(),
      pinFields: document.querySelectorAll('input[type=password]').length,
      scanDisabled: document.getElementById('previewBtn').disabled === true,
      addHidden: getComputedStyle(document.getElementById('addDomainBtn').closest('.card')).display === 'none',
      controlsHidden: getComputedStyle(document.getElementById('previewBtn').closest('.card')).display === 'none',
      listRows: document.getElementById('previewList').children.length,
      verdict: document.getElementById('siteVerdict').textContent.trim(),
      status: document.getElementById('status').textContent.trim()
    })`)
  );
  record('popup notes the lock instead of putting up a lock screen',
    lockView2.card && lockView2.bodyLocked && lockView2.note.length > 10, lockView2.note);
  // The popup used to take a PIN and do nothing with it, which is the thing that was
  // removed: there is now no password field on this page at all.
  record('the popup asks for no PIN', lockView2.pinFields === 0, `${lockView2.pinFields} password field(s)`);
  record('the popup keeps its controls', lockView2.addHidden === false && lockView2.controlsHidden === false);
  record('the list is off the screen and the scan is off with it',
    lockView2.listRows === 0 && lockView2.scanDisabled === true);
  // The verdict names what happens to this tab, so it says nothing while locked.
  record('popup says nothing about the tab while locked', lockView2.verdict === '', `"${lockView2.verdict}"`);
  await closePage(pop5.id);

  // --- 11. while the lock is on, nothing on either page names the list --------
  // A rule with a name worth hiding, then a sweep of everything a page can put on
  // screen: body text, every title/placeholder/value/aria-label, and the lists.
  const SECRET = 'hidden-secret.example';
  // The rule is written the way readRules() looks for it: the list lives in local
  // storage, so a local-only write is the real path. The synced area is read back too,
  // because "nothing of the user's is left where the browser would upload it" is a
  // claim the extension makes in writing.
  const seedResult = await ev(`(async()=>{
    try {
      const rule = { id: 'sec1', type: 'domain', value: ${JSON.stringify(SECRET)}, enabled: true };
      await chrome.storage.local.set({ rulesMeta: { chunks: 1, count: 1, at: Date.now() }, rulesChunk0: [rule] });
      await chrome.storage.local.set({ rules: [rule], rulesMirror: [rule] });
      const syncBag = await chrome.storage.sync.get(null);
      const local = await chrome.storage.local.get(['rules']);
      const settings = (await chrome.storage.local.get('settings')).settings || {};
      return JSON.stringify({
        syncItems: Object.keys(syncBag).length,
        local: local.rules && local.rules[0] && local.rules[0].value,
        lock: !!settings.lockEnabled,
      });
    } catch (e) {
      return JSON.stringify({ error: String(e && e.message ? e.message : e) });
    }
  })()`);
  const seededView = JSON.parse(String(seedResult));
  record(
    'the seed rule is in local storage, the PIN lock is on, and the synced area is empty',
    seededView.syncItems === 0 && seededView.local === SECRET && seededView.lock === true,
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

  // A pasted list becomes one rule per line, or one per comma. The second half of
  // this pair is where the teeth are: without the duplicate check, pasting a list
  // twice would double it, and the first check alone would still pass.
  const pasted = JSON.parse(
    await optLocked.evaluate(`(async()=>{
      const rows = () => document.getElementById('rulesBody').children.length;
      const before = rows();
      document.getElementById('ruleValue').value = 'paste-one.example\\npaste-two.example, paste-three.example';
      document.getElementById('addBtn').click();
      await new Promise(r=>setTimeout(r,900));
      const after = rows();
      const msg = document.getElementById('addMsg').textContent.trim();
      document.getElementById('ruleValue').value = 'paste-one.example\\npaste-two.example';
      document.getElementById('addBtn').click();
      await new Promise(r=>setTimeout(r,900));
      return JSON.stringify({ before, after, msg, again: rows() });
    })()`)
  );
  record(
    'a pasted list becomes one rule per line and per comma',
    pasted.after - pasted.before === 3,
    `${pasted.before} -> ${pasted.after} rows, message: ${pasted.msg}`
  );
  record(
    'pasting the same values again does not double the list',
    pasted.again === pasted.after,
    `${pasted.after} -> ${pasted.again} rows`
  );

  // The suggestions. The block sits with the advanced controls and under the lock, so
  // this flips the lock off, looks, and puts it back the way it was.
  const beforeSug = await openPage(`chrome-extension://${id}/src/options.html`);
  await beforeSug.evaluate(`(async()=>{
    const got = await new Promise(r=>chrome.storage.local.get('settings', r));
    const s = Object.assign({}, got.settings, { lockEnabled: false });
    await new Promise(r=>chrome.storage.local.set({ settings: s }, r));
    return 'ok';
  })()`);
  await closePage(beforeSug.id);

  const optSug = await openPage(`chrome-extension://${id}/src/options.html`);
  const suggested = JSON.parse(
    await optSug.evaluate(`(async()=>{
      const btn = document.getElementById('insightsBtn');
      const isButton = !!btn && btn.tagName === 'BUTTON';
      document.getElementById('tabLogs').click();
      const panel = document.getElementById('panelLogs');
      const visible = !!panel && getComputedStyle(panel).display !== 'none' && !!btn.closest('#panelLogs');
      btn.click();
      await new Promise(r=>setTimeout(r,2500));
      const list = document.getElementById('insightsList');
      const hosts = [...list.querySelectorAll('span.grow')].map((s)=>s.textContent.trim());
      const got = await new Promise(r=>chrome.storage.local.get('rules', r));
      const covered = (got.rules || []).map((x)=>String(x.value || '').toLowerCase());
      return JSON.stringify({ isButton, visible, lines: list.children.length, hosts, covered });
    })()`)
  );
  record(
    'the suggestions sit on the Logs tab, behind a real button',
    suggested.isButton === true && suggested.visible === true,
    `button=${suggested.isButton}, Logs panel visible=${suggested.visible}`
  );
  record(
    'asking for suggestions answers on screen instead of leaving a blank box',
    suggested.lines > 0,
    `${suggested.lines} line(s), sites: ${suggested.hosts.join(', ') || 'none found'}`
  );
  record(
    'nothing it suggests is a site the list already catches',
    suggested.hosts.every((h) => !suggested.covered.includes(h.toLowerCase())),
    `${suggested.hosts.length} suggested against ${suggested.covered.length} rule(s)`
  );

  await optSug.evaluate(`(async()=>{
    const got = await new Promise(r=>chrome.storage.local.get('settings', r));
    const s = Object.assign({}, got.settings, { lockEnabled: true });
    await new Promise(r=>chrome.storage.local.set({ settings: s }, r));
    return 'ok';
  })()`);
  await closePage(optSug.id);

  // The count a rule carries. The worker's own numbers are covered in its suite, so
  // this is the render path: the number is put in storage and read back off the row.
  const optSeedCount = await openPage(`chrome-extension://${id}/src/options.html`);
  const counted = JSON.parse(
    await optSeedCount.evaluate(`(async()=>{
      const got = await new Promise(r=>chrome.storage.local.get(['rules','settings','stats'], r));
      const rule = (got.rules || [])[0];
      const settings = Object.assign({}, got.settings, { lockEnabled: false });
      const byRule = Object.assign({}, (got.stats && got.stats.byRule) || {});
      byRule[rule.id] = 7;
      const stats = Object.assign({}, got.stats, { byRule });
      await new Promise(r=>chrome.storage.local.set({ settings, stats }, r));
      return JSON.stringify({ value: rule.value });
    })()`)
  );
  await closePage(optSeedCount.id);

  const optCounted = await openPage(`chrome-extension://${id}/src/options.html`);
  const countedTag = await optCounted.evaluate(`(()=>{
    const rows = [...document.querySelectorAll('#rulesBody tr')];
    const row = rows.find((r)=>r.textContent.includes(${JSON.stringify(counted.value)}));
    const tag = row && row.querySelector('td.value .tag:not(.on)');
    return tag ? tag.textContent.trim() : '';
  })()`);
  record(
    'a rule row shows how much that rule has removed',
    /\b7\b/.test(countedTag || ''),
    `the row for ${counted.value} shows: ${countedTag || 'nothing'}`
  );
  await closePage(optCounted.id);

  // The never-delete control on a rule row: it has to write the flag down, not just
  // look pressed, because the engine reads the flag and not the button.
  const optKeep = await openPage(`chrome-extension://${id}/src/options.html`);
  const keepOut = JSON.parse(
    await optKeep.evaluate(`(async()=>{
      await new Promise(r=>setTimeout(r,600));
      const btn = document.querySelector('#rulesBody .tag.keep');
      if (!btn) return JSON.stringify({ found: false });
      const before = btn.getAttribute('aria-pressed');
      btn.click();
      await new Promise(r=>setTimeout(r,500));
      const got = await new Promise(r=>chrome.storage.local.get(['rules'], r));
      const flag = (got.rules || []).some((rule) => rule.exempt === true);
      const now = document.querySelector('#rulesBody .tag.keep');
      return JSON.stringify({ found: true, before, after: now ? now.getAttribute('aria-pressed') : '', flag });
    })()`)
  );
  record(
    'a rule row can be told never to delete, and it writes that down',
    keepOut.found === true && keepOut.after === 'true' && keepOut.flag === true,
    keepOut.found
      ? `pressed ${keepOut.before} then ${keepOut.after}, stored flag: ${keepOut.flag}`
      : 'no never-delete button on the row'
  );
  await closePage(optKeep.id);

  // The popup surface. The numbers are put in storage first, so a fresh probe profile
  // cannot pass this by showing a zero that happens to be on screen.
  const optSeedPop = await openPage(`chrome-extension://${id}/src/options.html`);
  await optSeedPop.evaluate(`(async()=>{
    const got = await new Promise(r=>chrome.storage.local.get(['rules','settings','stats'], r));
    const rule = (got.rules || [])[0];
    const byRule = Object.assign({}, (got.stats && got.stats.byRule) || {});
    byRule[rule.id] = 42;
    const stats = Object.assign({}, got.stats, { byRule, wipedTotal: 1234 });
    const settings = Object.assign({}, got.settings, { lockEnabled: false });
    await new Promise(r=>chrome.storage.local.set({ settings, stats }, r));
    return 'ok';
  })()`);
  await closePage(optSeedPop.id);

  const popCaught = await openPage(`chrome-extension://${id}/src/popup.html`);
  const popStat = JSON.parse(
    await popCaught.evaluate(`(async()=>{
      await new Promise(r=>setTimeout(r,700));
      const total = (document.getElementById('keptOut') || {}).textContent || '';
      const title = document.querySelector('#caughtCard [data-i18n]');
      const rows = [...document.querySelectorAll('#topRules .row')].map((r)=>({
        text: r.textContent.trim(),
        count: (r.lastElementChild ? r.lastElementChild.textContent : '').trim(),
      }));
      return JSON.stringify({ total: total.trim(), rows, title: title ? title.textContent.trim() : '' });
    })()`)
  );
  record(
    'the popup says how much it has kept out',
    /1[.,\s]?234/.test(popStat.total),
    `${popStat.title || 'the popup'}: ${popStat.total || 'empty'}`
  );
  record(
    'the popup names the busiest rule and its count',
    popStat.rows.some((row) => /\b42\b/.test(row.count)),
    popStat.rows.map((row) => row.text).join(' | ') || 'no rows were drawn'
  );
  await closePage(popCaught.id);

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
        localMeta: (await chrome.storage.local.get('rulesMeta')).rulesMeta?.count ?? -1,
        syncItems: Object.keys(await chrome.storage.sync.get(null)).length,
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
    'its rule list is read out of the synced area and shown',
    afterUpgrade.rows === 2 && afterUpgrade.named === true,
    `${afterUpgrade.rows} row(s), named=${afterUpgrade.named}`
  );
  record(
    'that older list is moved into local storage, and the synced area emptied',
    afterUpgrade.mirrorCount === 2 && afterUpgrade.localMeta === 2 && afterUpgrade.syncItems === 0,
    `local copy ${afterUpgrade.mirrorCount}, local meta ${afterUpgrade.localMeta}, synced items left ${afterUpgrade.syncItems}`
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
  // A backup file, fed to the real file picker on the real page. The unit test covers
  // the parsing; this covers the wiring, which is the part a rename or a refactor
  // breaks without anything else noticing.
  const backup = JSON.stringify({
    app: 'lil-bro-history-wipe',
    version: 1,
    settings: { theme: 'paper' },
    rules: [
      {
        id: 'old1',
        type: 'domain',
        value: 'restored-from-backup.example',
        includeSubdomains: true,
        enabled: true,
        createdAt: 1758000009000,
      },
    ],
  });
  const afterImport = JSON.parse(
    await upPage.evaluate(`(async()=>{
      window.confirm = () => true;
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(backup)}], 'lil-bro-rules.json', { type: 'application/json' }));
      const input = document.getElementById('importFile');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,1200));
      return JSON.stringify({
        msg: document.getElementById('importMsg').textContent.trim(),
        listed: [...document.querySelectorAll('#rulesBody tr')].map(tr=>tr.textContent).join(' ').includes('restored-from-backup.example'),
        theme: document.documentElement.dataset.theme,
      });
    })()`)
  );
  record(
    'a backup file imports through the real picker',
    /^Imported 1 rule/.test(afterImport.msg) && afterImport.listed === true,
    afterImport.msg
  );
  record(
    'and the settings inside that file are applied, not just the rules',
    afterImport.theme === 'paper',
    afterImport.theme
  );
  await closePage(upPage.id);

  // --- 12b. the theme buttons draw their own theme ----------------------------
  // A swatch reads its colours from the theme it previews, so an empty custom property
  // leaves it showing the card fill and the row looks broken. Measured, because a
  // description of a small tile is not evidence.
  {
    const look = await openPage(`chrome-extension://${id}/src/options.html`);
    // The theme row lives on the Advanced tab now, and a hidden panel measures as zero.
    await look.evaluate("document.getElementById('tabAdvanced').click()");
    const swatches = await look.evaluate(`(() => [...document.querySelectorAll('.theme')].map((b) => {
      const i = b.querySelector('i');
      const bar = i && i.querySelector('b');
      return {
        theme: b.dataset.theme,
        width: i ? Math.round(i.getBoundingClientRect().width) : 0,
        fill: i ? getComputedStyle(i).backgroundColor : '',
        image: i ? getComputedStyle(i).backgroundImage : '',
        bar: bar ? getComputedStyle(bar).backgroundColor : '',
      };
    }))()`);
    const solid = swatches.filter((s) => s.fill && s.fill !== 'rgba(0, 0, 0, 0)');
    const fills = [...new Set(solid.map((s) => s.fill))];
    const auto = swatches.find((s) => s.theme === 'auto');
    record('the theme row carries eight buttons', swatches.length === 8, swatches.map((s) => s.theme).join(' '));
    // midnight and contrast share a black page, so six distinct fills across seven
    // solid swatches is right: what tells those two apart is the accent bar and the
    // border, which is why the bar is checked separately below.
    record('every solid swatch draws its own theme page colour', solid.length === 7 && fills.length >= 6,
      `${solid.length} solid, ${fills.length} distinct: ${fills.join(' ')}`);
    record('every swatch keeps its accent bar', swatches.every((s) => s.bar && s.bar !== 'rgba(0, 0, 0, 0)'),
      swatches.map((s) => s.bar).join(' ').slice(0, 110));
    record('auto shows the dark and the light page side by side',
      !!auto && auto.image.includes('rgb(245, 247, 251)') && auto.image.includes('rgb(10, 16, 24)'),
      auto ? auto.image.slice(0, 96) : 'no auto swatch');
    record('a swatch is a small tile, not a stripe', swatches.every((s) => s.width === 22),
      swatches.map((s) => s.width).join(','));

    // The page has to say what it is doing before anyone scrolls, and every row's text
    // has to start at the same x. Both are geometry, so both are measured here.
    const hasDigit = (s) => /[0-9]/.test(s || '');
    // The rows this block measures live on the day-to-day tab, and the swatch check above
    // left the page on Advanced: a hidden panel measures as zero.
    await look.evaluate("document.getElementById('tabCleaning').click()");
    const facts = await look.evaluate(`(() => {
      const textLeft = (el) => el
        ? Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
        : null;
      const text = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        return el.classList.contains('hidden') ? null : el.textContent.trim();
      };
      const strip = document.querySelector('.glance');
      const dotOf = (id) => (document.getElementById(id) || {}).className || null;
      const row = document.querySelector('.card > .row.mini');
      const label = document.querySelector('label.radio');
      return {
        stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
        state: text('glanceState'),
        rules: text('glanceRules'),
        last: text('glanceLast'),
        stripDot: dotOf('glanceDot'),
        cardDot: dotOf('stateDot'),
        labelX: textLeft(document.querySelector('label.radio b')),
        noteX: textLeft(row),
        // the boxes as well as the text, so a miss says which of the two moved
        labelBox: label ? Math.round(label.getBoundingClientRect().left) : null,
        noteId: row ? (row.id || row.className) : null,
        rowBox: row ? Math.round(row.getBoundingClientRect().left) : null,
        rowPad: row ? parseFloat(getComputedStyle(row).paddingLeft) : null,
        pillX: textLeft(document.querySelector('label.pill span')),
      };
    })()`);
    // No seconds: the strip is a summary line, and toLocaleString() would put them there.
    const hasSeconds = (s) => /:[0-9][0-9]:[0-9][0-9]/.test(s || '');
    record('the top of the page says what is on, how many rules, and the last clean',
      facts.stripHeight > 20 && !!facts.state && hasDigit(facts.rules) &&
        (!facts.last || (hasDigit(facts.last) && !hasSeconds(facts.last))),
      `${facts.state} | ${facts.rules} | ${facts.last === null ? 'no run yet, hidden' : facts.last}`);
    record('the strip carries the same state dot as the status card',
      !!facts.stripDot && facts.stripDot === facts.cardDot, `${facts.stripDot} vs ${facts.cardDot}`);
    record('a note under a row lines up with the label it explains',
      Math.abs(facts.labelX - facts.noteX) <= 1,
      `label x=${facts.labelX} (row ${facts.labelBox}), note x=${facts.noteX} (${facts.noteId} ${facts.rowBox}+${facts.rowPad})`);
    record('choosing rows and on/off rows share one text column',
      Math.abs(facts.labelX - facts.pillX) <= 1, `label x=${facts.labelX}, pill x=${facts.pillX}`);

    // A select with appearance:none and no background-image is an unmarked box: nothing
    // says it opens. The arrow has to be drawn by the sheet, so it is read off the page.
    const lang = await look.evaluate(`(() => {
      const s = document.getElementById('langPick');
      if (!s) return null;
      const cs = getComputedStyle(s);
      return {
        appearance: cs.appearance || cs.webkitAppearance,
        arrow: /gradient/.test(cs.backgroundImage),
        options: s.options.length,
        width: Math.round(s.getBoundingClientRect().width),
        height: Math.round(s.getBoundingClientRect().height),
      };
    })()`);
    record('the language picker draws its own arrow',
      !!lang && lang.appearance === 'none' && lang.arrow && lang.options >= 2,
      lang ? `appearance:${lang.appearance}, arrow:${lang.arrow ? 'drawn' : 'MISSING'}, ` +
        `${lang.options} options, ${lang.width}x${lang.height}` : 'no picker on the page');
    await closePage(look.id);
  }

  // --- 12c. every word in every theme can be read ---------------------------
  // A theme is a pile of colour pairs, and an unreadable pair only shows up in the
  // rendered page: each token reads fine on its own. Every element's own text colour is
  // composited onto its real backdrop, translucent ancestors included, and measured
  // against the WCAG ratio for its size: 4.5 for body text, 3 for large or bold text.
  {
    const themes = await (async () => {
      const p = await openPage(`chrome-extension://${id}/src/options.html`);
      const list = await p.evaluate(`[...document.querySelectorAll('.theme')].map((b) => b.dataset.theme)`);
      await closePage(p.id);
      return list;
    })();

    const sweep = `(() => {
      const parse = (c) => {
        const m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const name = (el) => el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(' ').slice(0, 2).join('.')
          : '');
      // A background is a stack: image layers on top, the colour underneath. Reading only
      // backgroundColor walks past the gradient, and reading only the gradient's first
      // stop reads a 16% tint as a solid colour. All the layers come back top-first, so
      // the walk can composite them in the order the browser paints them.
      const paints = (node) => {
        const cs = getComputedStyle(node);
        const out = [];
        const img = cs.backgroundImage;
        if (img && img !== 'none') {
          for (const s of img.match(/rgba?\\([^)]*\\)/g) || []) {
            const c = parse(s);
            if (c) out.push(c);
          }
        }
        const flat = parse(cs.backgroundColor);
        if (flat && flat.a > 0) out.push(flat);
        return out;
      };
      const rootPaint = () => {
        // documentElement is often transparent, and a transparent colour is still a
        // truthy object, so it has to be tested for opacity rather than existence or the
        // walk silently falls back to white and every dark theme reads as light.
        for (const el of [document.documentElement, document.body]) {
          const c = parse(getComputedStyle(el).backgroundColor);
          if (c && c.a >= 1) return c;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const backdrop = (el) => {
        let node = el;
        // The walk starts on the page's own colour, so a translucent paint that reaches
        // the top (accent-soft at 16%) is composited onto something instead of being
        // reported as a solid accent, which fakes a contrast ratio of 1 everywhere.
        let acc = rootPaint();
        let from = null;
        while (node) {
          const layers = paints(node);
          if (layers.length) {
            if (!from) from = name(node);
            for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
            // An opaque layer anywhere in the stack stops everything behind it.
            if (layers.some((c) => c.a >= 1)) break;
          }
          node = node.parentElement;
        }
        return { bg: acc, from: from || 'the page' };
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const bad = [];
      let checked = 0;
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (!own.length) continue;
        const fg0 = parse(cs.color);
        if (!fg0) continue;
        const { bg, from } = backdrop(el);
        const fg = over(fg0, bg);
        const size = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        const r = ratio(fg, bg);
        checked++;
        if (r < need) {
          bad.push({
            el: name(el),
            text: own.map((n) => n.textContent.trim()).join(' ').slice(0, 30),
            ratio: Math.round(r * 100) / 100,
            need,
            color: cs.color,
            on: 'rgb(' + [bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(', ') + ')',
            from,
          });
        }
      }
      bad.sort((a, b) => a.ratio - b.ratio);
      return JSON.stringify({ checked, total: bad.length, worst: bad.slice(0, 6) });
    })()`;

    const unreadable = [];
    let measured = 0;
    for (const theme of themes) {
      await ev(`(async()=>{
        const s = (await chrome.storage.local.get('settings')).settings || {};
        await chrome.storage.local.set({ settings: Object.assign({}, s, { theme: ${JSON.stringify(theme)} }) });
        return 'ok';
      })()`);
      for (const page of ['options.html', 'popup.html']) {
        const p = await openPage(`chrome-extension://${id}/src/${page}`);
        const res = JSON.parse(await p.evaluate(sweep));
        await closePage(p.id);
        measured += res.checked;
        if (res.total) unreadable.push({ theme, page, total: res.total, worst: res.worst });
      }
    }
    record(
      'every word in every theme can be read',
      unreadable.length === 0,
      unreadable.length
        ? unreadable.map((u) => `${u.theme}/${u.page.replace('.html', '')}:${u.total}`).join(' ') +
            ' | ' +
            unreadable
              .slice(0, 6)
              .map(
                (u) =>
                  `${u.theme}: ` +
                  u.worst
                    .slice(0, 2)
                    .map((w) => `${w.el} "${w.text}" ${w.ratio} on ${w.on} from ${w.from} (need ${w.need})`)
                    .join('; ')
              )
              .join(' | ')
        : `${measured} text elements measured across ${themes.length} themes x 2 pages`
    );
  }

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

    // The override is applied once per page and size. Re-applying it before every capture
    // re-lays out the page and drops the scroll position, which is how the framed shots
    // ended up starting in the wrong place.
    let appliedMetrics = null;
    const shoot = async (page, file, width, height, full, scale = 2) => {
      const key = `${page.id}|${width}x${height}@${scale}`;
      if (appliedMetrics !== key) {
        await page.send('Page.enable');
        await page.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: scale,
          mobile: false,
        });
        appliedMetrics = key;
        await sleep(400);
      }
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

    // The store takes 1280x800 or 640x400, and downscales everything to 640x400: its
    // own note says a screenshot with a lot of text looks bad when that happens. So the
    // page is shot at a 640x400 viewport with scale 2, which produces a 1280x800 file
    // whose content fills the frame and whose downscale is still readable. At a 1280
    // viewport the content column (max 800px) left 240px of empty page each side and the
    // text came out at half size, which is what the store warns about.
    // The popup is a 360px panel, so it is shot at 2x and composed onto that canvas
    // afterwards, which is what tools/make_shot_sheets.py does.
    const shotPopup = await openPage(`chrome-extension://${id}/src/popup.html`, dialogs);
    await shoot(shotPopup, 'popup-compact.png', 360, 520, false);

    // A Polish screen must not carry an English sentence. Every bundle value that differs
    // between the two locales is looked for in what the pages actually render, because a
    // key a locale lacks falls back to the English literal sitting beside it in the code.
    // No unit test can see that, and it is exactly how English kept appearing in the
    // Polish build while every check passed.
    if (shotLang === 'pl') {
      const enBundle = JSON.parse(readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
      const plBundle = JSON.parse(readFileSync(path.join(ROOT, '_locales/pl/messages.json'), 'utf8'));
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const englishOnly = Object.keys(enBundle)
        .filter((k) => {
          const m = enBundle[k].message;
          return plBundle[k] && plBundle[k].message !== m && m.length >= 22 && m.includes(' ');
        })
        .map((k) => ({
          key: k,
          re: new RegExp(
            esc(enBundle[k].message).replace(/\\\$[123]/g, '.{0,24}').replace(/\\n+/g, '\\s+'),
            'i'
          ),
        }));
      const popupText = await shotPopup.evaluate('document.body.innerText');
      const langCheck = await openPage(`chrome-extension://${id}/src/options.html`);
      const optionsText = await langCheck.evaluate('document.body.innerText');
      await closePage(langCheck.id);
      const hits = englishOnly.filter((e) => e.re.test(popupText) || e.re.test(optionsText));
      record(
        'no English sentence is left on a Polish screen',
        hits.length === 0,
        hits.length ? hits.slice(0, 4).map((h) => h.key).join(', ') : `${englishOnly.length} sentences checked`
      );
    }
    await closePage(shotPopup.id);

    const shotOptions = await openPage(`chrome-extension://${id}/src/options.html`);
    await shoot(shotOptions, 'options.png', 640, 400, false, 2);
    // Scrolled to the list rather than to a pixel offset: the page is a different
    // length at a 640 viewport, so a fixed offset lands somewhere else every time.
    // The card's own top edge, not the list body: starting at the body clipped the card's
    // first row and left the frame opening mid-panel.
    await shotOptions.evaluate(
      "document.getElementById('rulesBody').closest('.card').scrollIntoView({ block: 'start' })"
    );
    await sleep(400);
    await shoot(shotOptions, 'options-lower.png', 1280, 800, false, 1);
    // The Look and Language cards sit below the log, so no plain top-of-page capture
    // can show them. Scrolled to, they are the two controls worth a picture: the
    // theme row, and the language menu that replaced three full-width rows.
    // The frame is placed by measuring the theme row's own position, not by aligning a card
    // to an edge of the viewport: the previous version asked for the language card's bottom
    // on the frame's bottom, which framed the rule table instead, and nothing failed because
    // the page still scrolled somewhere. The metrics are set first, because the offset is
    // only meaningful at the size the shot is taken at and a later reflow would move it.
    await shotOptions.evaluate("document.getElementById('tabAdvanced').click()");
    await shoot(shotOptions, 'options-look.png', 640, 400, false, 2);
    await shotOptions.evaluate(`(() => {
      const row = document.getElementById('themeRow');
      const top = row.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, Math.round(top - 96)));
      return true;
    })()`);
    await sleep(400);
    // What the frame actually holds. A shot whose subject is out of frame still looks
    // like a shot, so this is checked in the same place the capture is taken.
    const inFrame = await shotOptions.evaluate(`(() => {
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
      };
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        theme: r(document.getElementById('themeRow')),
        lang: r(document.getElementById('langPick')),
        // The language menu lives on the Advanced tab, so where it sits is part of what
        // has to hold: the frame can no longer show it, and the page should only ever
        // offer it from inside that panel.
        langInAdv: !!document.getElementById('langPick')?.closest('#panelAdvanced'),
        tiles: document.querySelectorAll('.theme').length,
      };
    })()`);
    record('the fifth shot holds the theme row, and the language menu sits on the Advanced tab',
      inFrame.theme.top >= 0 && inFrame.theme.bottom <= inFrame.h && inFrame.langInAdv,
      `frame ${inFrame.w}x${inFrame.h}, theme row ${inFrame.theme.top}..${inFrame.theme.bottom}, ` +
        `language menu ${inFrame.langInAdv ? 'on the Advanced tab' : `OUT at ${inFrame.lang.top}..${inFrame.lang.bottom}`}, ${inFrame.tiles} tiles`);
    await shoot(shotOptions, 'options-look.png', 640, 400, false, 2);

    // The store shows every screenshot at 640 wide, so a row that wraps at that width
    // wraps in the listing. Eight tiles on one line is the thing being checked, at the
    // width the shots are taken at rather than at a wide window where anything fits.
    const rowFit = await shotOptions.evaluate(`(() => {
      const tiles = [...document.querySelectorAll('.theme')];
      const byTop = new Map();
      for (const t of tiles) {
        const k = Math.round(t.getBoundingClientRect().top);
        byTop.set(k, (byTop.get(k) || 0) + 1);
      }
      const lines = [...byTop.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      const box = document.querySelector('.themes');
      const cs = getComputedStyle(box);
      return {
        tiles: tiles.length,
        lines,
        clientWidth: Math.round(box.clientWidth),
        display: cs.display,
        columns: cs.gridTemplateColumns,
        widths: tiles.map((t) => Math.round(t.getBoundingClientRect().width)).join(','),
        tops: tiles.map((t) => Math.round(t.getBoundingClientRect().top)).join(','),
      };
    })()`);
    // One line when they fit, an even block when they do not. A single tile stranded on
    // its own line is the failure, not the wrap itself.
    record('the theme tiles form an even block at the width the store shots use',
      rowFit.lines.every((n) => n >= 4),
      `${rowFit.tiles} tiles as ${rowFit.lines.join('+')} per line, container ${rowFit.clientWidth}px, display:${rowFit.display}, cols:${rowFit.columns}, widths:${rowFit.widths}, tops:${rowFit.tops}`);

    // The tab strip is the page's navigation now. What has to hold: clicking a tab brings
    // its panel and only its panel, and the selected tab says so on the element.
    const walk = await shotOptions.evaluate(`(() => {
      const out = [];
      for (const id of ['tabCleaning', 'tabLogs', 'tabAdvanced']) {
        const tab = document.getElementById(id);
        tab.click();
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        out.push({
          id,
          selected: tab.getAttribute('aria-selected'),
          shown: !!panel && getComputedStyle(panel).display !== 'none',
          others: [...document.querySelectorAll('.panel')].filter((p) => p !== panel && getComputedStyle(p).display !== 'none').length,
        });
      }
      window.scrollTo(0, 0);
      return out;
    })()`);
    await sleep(400);
    await shoot(shotOptions, 'options-tabs.png', 640, 400, false, 2);
    record('every tab brings its own panel, and only its own',
      walk.every((w) => w.selected === 'true' && w.shown && w.others === 0),
      walk.map((w) => `${w.id} ${w.selected}/${w.shown ? 'shown' : 'HIDDEN'}/${w.others} others`).join(' | '));
    await closePage(shotOptions.id);

    // A log row is read by a person, so what one says is checked in the real page: the
    // page title first, then the reason in words, then the bit of the address around the
    // match rather than the whole two-kilobyte token it sits in. This runs before the
    // lock below, because a locked page shows no log at all, by design.
    const tokenUrl = 'https://nordaccount.com/oauth2/initiate?challenge=' + 'N'.repeat(120) + 'zDgaY_krxd6DvgF' + 'Q'.repeat(120);
    const seeded = await openPage(`chrome-extension://${id}/src/options.html`);
    await seeded.evaluate(`(async()=>{
      const at = Date.now();
      await chrome.storage.local.set({ log: [
        { url: ${JSON.stringify(tokenUrl)}, title: '2 Gay Guys dancing in the kitchen - Video', rule: 'keyword "gay"',
          why: 'word-url', word: 'gay', excerpt: '…zDgaY_krxd6DvgF…', at },
        { url: 'https://news.example/watch', title: '', rule: 'keyword "gay"',
          why: 'word-title', word: 'gay', excerpt: '', at: at - 1000 },
        { url: 'https://old.example/x', title: 'An older row', rule: 'example.com', at: at - 2000 }
      ] });
      return true;
    })()`);
    await closePage(seeded.id);
    // A fresh page rather than a reload in place: navigating while an evaluate is
    // pending loses its result.
    const logPage = await openPage(`chrome-extension://${id}/src/options.html`);
    await sleep(500);
    const rows = await logPage.evaluate(`(() => [...document.querySelectorAll('#logList .logline')].map((r) => ({
      head: (r.querySelector('.h') || {}).textContent || '',
      why: (r.querySelector('.w') || {}).textContent || '',
      meta: (r.querySelector('.m') || {}).innerText || ''
    })))()`);
    const row = (i) => rows[i] || { head: '', why: '', meta: '' };
    record('a log row leads with what the page was called',
      /2 Gay Guys dancing/.test(row(0).head), `${row(0).head}`);
    record('a log row says which word, and which of the two texts held it',
      /gay/i.test(row(0).why) && /address|adres/i.test(row(0).why), `${row(0).why}`);
    record('a log row shows the neighbourhood of the match, not the whole address',
      /zDgaY/.test(row(0).meta) && !/N{20}/.test(row(0).why), `${row(0).meta.slice(0, 90)}`);
    record('a row with no page title falls back to the site',
      /news\.example/.test(row(1).head), `${row(1).head}`);
    record('a row written by an older build still says something',
      /example\.com/.test(row(2).why), `${row(2).why}`);
    await closePage(logPage.id);

    // The same options page with a PIN set, which is what the lock looks like.
    await ev(`(async()=>{
      const hex=(b)=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
      const salt=crypto.getRandomValues(new Uint8Array(16));
      const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('2468'),'PBKDF2',false,['deriveBits']);
      const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:1000,hash:'SHA-256'},key,256);
      const cur=(await chrome.storage.local.get('settings')).settings||{};
      await chrome.storage.local.set({settings:{...cur,lockEnabled:true,lockHash:hex(bits),lockSalt:hex(salt),lockIterations:1000}});
      return 'ok';
    })()`);
    const shotLocked = await openPage(`chrome-extension://${id}/src/options.html`);
    await sleep(800);
    const lockedTabs = JSON.parse(
      await shotLocked.evaluate(`JSON.stringify({
        logsDisabled: document.getElementById('tabLogs').disabled,
        ariaDisabled: document.getElementById('tabLogs').getAttribute('aria-disabled'),
        selected: document.querySelector('.tab[aria-selected="true"]').id,
        stillHidden: (document.getElementById('tabLogs').click(), document.getElementById('panelLogs').classList.contains('hidden')),
      })`)
    );
    await shoot(shotLocked, 'options-locked.png', 640, 400, false, 2);
    record('while the PIN holds, the Logs tab is greyed out and does not open',
      lockedTabs.logsDisabled === true && lockedTabs.ariaDisabled === 'true' &&
        lockedTabs.selected === 'tabAdvanced' && lockedTabs.stillHidden === true,
      `disabled: ${lockedTabs.logsDisabled}, aria: ${lockedTabs.ariaDisabled}, opens on ${lockedTabs.selected}, Logs panel still hidden after a click: ${lockedTabs.stillHidden}`);
    await closePage(shotLocked.id);
  }
  // The keyboard shortcut's job, driven through the same message it uses. A browser
  // cannot be asked to press a key, so the work is exercised here and the command itself
  // is checked in the manifest: between them both halves of the feature are covered.
  const sitePage = await openPage(`chrome-extension://${id}/src/popup.html`);
  const rawShortcut = await sitePage.evaluate(`(async () => {
    const out = { before: null, left: null, others: null, res: null, commands: null, error: null };
    try {
      out.commands = chrome.runtime.getManifest().commands || null;
      const url = 'https://probe-site.test/one';
      await chrome.history.addUrl({ url });
      await chrome.history.addUrl({ url: 'https://probe-site.test/two' });
      await chrome.history.addUrl({ url: 'https://example.com/keep-me' });
      const search = () => chrome.history.search({ text: '', startTime: 0, maxResults: 0 });
      out.before = (await search()).filter((e) => e.url.includes('probe-site.test')).length;
      out.res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'wipeSiteNow', url }, r));
      out.left = (await search()).filter((e) => e.url.includes('probe-site.test')).length;
      out.others = (await search()).filter((e) => e.url.includes('example.com/keep-me')).length;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return JSON.stringify(out);
  })()`);
  // The helper hands back an object when the page returned JSON and a string when it did
  // not, so take either rather than assuming: the first version assumed and cost a run.
  const shortcut = typeof rawShortcut === 'string' ? JSON.parse(rawShortcut) : rawShortcut;
  record('the shortcut takes that site out of history and leaves the rest alone',
    shortcut.before === 2 && shortcut.left === 0 && shortcut.others === 1 &&
      shortcut.res && shortcut.res.ok === true && !shortcut.error,
    `${shortcut.before} there before, ${shortcut.left} after, ${shortcut.others} other site kept, wiped ${shortcut.res && shortcut.res.wiped}, error ${shortcut.error}`);
  record('the shortcut is declared, so the browser can offer it',
    !!(shortcut.commands && shortcut.commands['wipe-site'] &&
      shortcut.commands['wipe-site'].suggested_key),
    JSON.stringify(shortcut.commands || null));
  await closePage(sitePage.id);
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
