// Lil Bro: options page

import {
  getState,
  saveState,
  mergeSettings,
  buildRule,
  describeRule,
  activeRules,
  readAttempts,
  writeAttempts,
  factoryReset,
  extraOn,
  describeExtras,
  EXTRA_SINCE_LABELS,
  PRESETS,
  presetPatch,
  presetName,
  parseCookieKeep,
  RULE_TYPES,
} from './store.js';
import { applyI18n, t } from './i18n.js';
import { findMatch } from './matcher.js';
import {
  doubleConfirm,
  singleConfirm,
  MESSAGES,
  WIPE_ALL_PHRASE,
} from './confirm-gate.js';
import {
  makePinRecord,
  verifyPin,
  isLockConfigured,
  pinProblem,
  attemptState,
  checkRecovery,
  LOCK_MESSAGES,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
} from './lock.js';

const $ = (id) => document.getElementById(id);

let state = null;
// The lock lasts as long as this page is open: a reload hides the list again.
let unlocked = false;
let pinIntent = 'unlock';

function fmtWhen(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function setMsg(el, text, kind = '') {
  el.textContent = text || '';
  el.className = kind || 'mini';
}

async function load() {
  state = await getState();
  renderSettings();
  renderStats();
  renderExtras();
  applyLock();
  if (isLocked()) {
    // While the lock is on, nothing naming a site is put into the page at all.
    $('rulesBody').innerHTML = '';
    $('logList').innerHTML = '';
    $('previewList').innerHTML = '';
    $('rulesEmpty').classList.add('hidden');
    $('logEmpty').classList.add('hidden');
  } else {
    renderRules();
    renderLog();
    runTest();
  }
  $('version').textContent =
    'Lil Bro v' + chrome.runtime.getManifest().version + ': rules sync between your computers, the switches stay on this one.';
}

/** A PIN is set and this page has not been unlocked yet. */
function isLocked() {
  return isLockConfigured(state.settings) && !unlocked;
}

/** Show the right PIN row, and hide the list sections while locked. */
function applyLock() {
  const configured = isLockConfigured(state.settings);
  const wantsOn = $('lockEnabled').checked;
  const locked = isLocked();
  document.body.classList.toggle('locked', locked);
  $('lockedBanner').classList.toggle('hidden', !locked);
  $('lockSetupRow').classList.toggle('hidden', !(wantsOn && !configured));
  $('lockUnlockRow').classList.toggle('hidden', !configured || unlocked);
  $('lockNowRow').classList.toggle('hidden', !configured || locked);
  $('lockHonest').textContent = LOCK_MESSAGES.honest;
  // Preview prints the URLs it matched, so it stays shut while locked.
  $('lockForgotRow').classList.toggle('hidden', !locked);
  if (!locked) $('lockRecoverRow').classList.add('hidden');
  $('previewBtn').disabled = locked;
  $('previewList').classList.toggle('hidden', locked);
}

function showUnlock(intent, message) {
  pinIntent = intent;
  $('lockUnlockRow').classList.remove('hidden');
  setMsg($('lockMsg'), message, 'warn');
  $('lockPin').focus();
}

function renderSettings() {
  const s = state.settings;
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.checked = input.value === s.mode;
  }
  $('sweep').checked = !!s.sweepExistingOnStartup;
  $('notify').checked = !!s.notifyOnWipe;
  $('logEnabled').checked = !!s.logEnabled;
  $('wipeAll').checked = !!s.wipeAllHistory;
  $('keepOnly').checked = s.listMode === 'allow';
  $('lockEnabled').checked = !!s.lockEnabled;
  $('keepWarn').textContent =
    s.listMode === 'allow' ? 'On: everything not on your list is being wiped. Cookies and cache are separate.' : '';
  $('wipeNowBtn').textContent = s.wipeAllHistory ? 'Wipe ALL history now' : 'Wipe now';
  $('wipeAllWarn').textContent = s.wipeAllHistory
    ? 'ARMED: the entire history is erased on every trigger above, and "Wipe now" empties it immediately.'
    : 'Off by default. Your rules are still being applied.';

  const enabled = s.enabled;
  $('stateDot').className = 'dot' + (enabled ? '' : ' off') + (s.wipeAllHistory ? ' danger' : '');
  const modeText = {
    realtime: 'wiping on visit',
    onclose: 'wiping at browser close',
    startup: 'wiping at browser start',
  }[s.mode] || s.mode;
  $('stateText').textContent = s.wipeAllHistory
    ? enabled
      ? 'ARMED: wiping ALL history'
      : 'Paused'
    : !enabled
      ? 'Paused'
      : s.listMode === 'allow'
        ? 'Active: wiping all but your keep list'
        : `Active: ${modeText}`;
}

/** The extra clear: what is on, how far back it reaches, and when it runs. */
function renderExtras() {
  const s = state.settings;
  $('extraCache').checked = !!s.extraCache;
  $('extraCookies').checked = !!s.extraCookies;
  $('extraDownloads').checked = !!s.extraDownloads;
  $('extraFormData').checked = !!s.extraFormData;
  $('extraSince').value = s.extraSince;
  $('extraTrigger').value = s.extraTrigger;
  $('extraNowBtn').disabled = !extraOn(s);

  const kinds = describeExtras(s);
  if (!kinds) {
    setMsg($('extraWarn'), '');
  } else {
    const reach = EXTRA_SINCE_LABELS[s.extraSince] || s.extraSince;
    const when =
      s.extraTrigger === 'manual'
        ? 'only when you press a button'
        : 'on a button, and again when the browser closes or starts';
    setMsg($('extraWarn'), `On: ${kinds}, covering ${reach}, ${when}.`, 'warn');
  }
  renderPresets();
  renderCookies();
}

/** Which preset is active, and the switches when none of them fit. */
function renderPresets() {
  const name = presetName(state.settings);
  for (const btn of document.querySelectorAll('.preset')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === name));
  }
  $('customRow').classList.toggle('hidden', name !== 'custom');
  const notes = {
    off: 'History only. Nothing else is cleared.',
    light: 'Cache goes with each run.',
    standard: 'Cache, cookies and saved form text.',
    nuclear: 'Cache, cookies, form text, download history, and all of your history.',
    custom: 'Your own mix of the four switches.',
  };
  setMsg($('presetNote'), notes[name] || '', name === 'nuclear' ? 'err' : 'mini');
}

/** The cookie keep list and the two cookie triggers. */
function renderCookies() {
  const s = state.settings;
  $('cookiesOnStart').checked = !!s.cookiesOnStart;
  $('cookiesOnTabClose').checked = !!s.cookiesOnTabClose;
  $('cookieKeep').value = (s.cookieKeep || []).join('\n');
  const on = s.cookiesOnStart || s.cookiesOnTabClose;
  setMsg(
    $('cookiesWarn'),
    on
      ? 'Cookies are deleted for every site except the list below, so logins everywhere else end.'
      : 'Off. Cookies are only cleared if you turn on the cookie switch in Clearing above, or press the button below.'
  );
  $('tabsPermBtn').classList.toggle('hidden', !s.cookiesOnTabClose);
}

function renderRules() {
  const body = $('rulesBody');
  body.innerHTML = '';
  const rules = state.rules;
  $('rulesEmpty').classList.toggle('hidden', rules.length > 0);

  for (const rule of rules) {
    const tr = document.createElement('tr');

    const tdType = document.createElement('td');
    tdType.textContent = RULE_TYPES[rule.type] || rule.type;
    tr.appendChild(tdType);

    const tdValue = document.createElement('td');
    tdValue.className = 'value';
    tdValue.textContent = rule.value;
    if (rule.type === 'domain' && rule.includeSubdomains) {
      const tag = document.createElement('span');
      tag.className = 'tag on';
      tag.textContent = '+ subdomains';
      tdValue.appendChild(tag);
    }
    if (rule.type === 'keyword' && rule.wholeWord) {
      const tag = document.createElement('span');
      tag.className = 'tag on';
      tag.textContent = 'whole words';
      tdValue.appendChild(tag);
    }
    tr.appendChild(tdValue);

    const tdOn = document.createElement('td');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = rule.enabled !== false;
    toggle.addEventListener('change', async () => {
      rule.enabled = toggle.checked;
      await saveState({ rules: state.rules });
      runTest();
    });
    tdOn.appendChild(toggle);
    tr.appendChild(tdOn);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      if (!window.confirm(MESSAGES.removeRule(describeRule(rule)))) return;
      state.rules = state.rules.filter((r) => r.id !== rule.id);
      await saveState({ rules: state.rules });
      renderRules();
      runTest();
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);

    body.appendChild(tr);
  }
}

function renderStats() {
  const st = state.stats;
  $('statTotal').textContent = st.wipedTotal || 0;
  $('statLastCount').textContent = st.lastRunCount || 0;
  $('lastRun').textContent = st.lastRunAt
    ? `Last run: ${fmtWhen(st.lastRunAt)} (${st.lastRunPhase || 'run'})`
    : 'No runs yet.';

  const queued = (state.pending || []).length;
  $('queueInfo').textContent =
    state.settings.mode === 'realtime'
      ? ''
      : `${queued} ${queued === 1 ? 'entry' : 'entries'} queued, wiped ${
          state.settings.mode === 'onclose' ? 'when you close the browser' : 'at your next start'
        }.`;
}

function renderLog() {
  const list = $('logList');
  list.innerHTML = '';
  const entries = state.log || [];
  $('logEmpty').classList.toggle('hidden', entries.length > 0);

  for (const e of entries.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'logline';
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = e.url;
    const r = document.createElement('span');
    r.className = 'r';
    r.textContent = e.rule || '';
    const t = document.createElement('span');
    t.className = 'mini';
    t.textContent = fmtWhen(e.at);
    row.append(u, r, t);
    list.appendChild(row);
  }
}

function runTest() {
  const url = $('testUrl').value.trim();
  const title = $('testTitle').value.trim();
  if (!url && !title) {
    setMsg($('testOut'), 'Nothing tested yet.');
    return;
  }
  const live = activeRules(state.rules);
  const keep = state.settings.listMode === 'allow';
  if (!live.length) {
    setMsg(
      $('testOut'),
      keep ? 'The keep list is empty, so nothing is wiped.' : 'No active rules, so nothing would be wiped.',
      'warn'
    );
    return;
  }
  const rule = findMatch({ url, title }, live);
  if (keep) {
    setMsg(
      $('testOut'),
      rule ? 'Kept: this page is on your keep list.' : 'Not on your keep list, so this would be wiped.',
      rule ? 'ok' : 'warn'
    );
    return;
  }
  if (rule) {
    setMsg($('testOut'), `Would be wiped by: ${RULE_TYPES[rule.type]} → ${describeRule(rule)}`, 'ok');
  } else {
    setMsg($('testOut'), 'No rule matches this, so it stays in history.', 'mini');
  }
}

function syncRuleTypeUi() {
  const type = $('ruleType').value;
  $('subWrap').classList.toggle('hidden', type !== 'domain');
  $('wordWrap').classList.toggle('hidden', type !== 'keyword');
  const placeholders = {
    domain: 'example.com',
    url: 'https://example.com/private',
    keyword: 'shoes',
    regex: '^https://translate\\.google\\.com/',
  };
  $('ruleValue').placeholder = placeholders[type] || '';
}

// --- events ----------------------------------------------------------------

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', async () => {
    if (!input.checked) return;
    state.settings.mode = input.value;
    await saveState({ settings: state.settings });
    renderSettings();
  });
}

$('sweep').addEventListener('change', async () => {
  state.settings.sweepExistingOnStartup = $('sweep').checked;
  await saveState({ settings: state.settings });
});
$('notify').addEventListener('change', async () => {
  state.settings.notifyOnWipe = $('notify').checked;
  await saveState({ settings: state.settings });
});
$('logEnabled').addEventListener('change', async () => {
  state.settings.logEnabled = $('logEnabled').checked;
  await saveState({ settings: state.settings });
});

// --- the extra clear -------------------------------------------------------

for (const [id, key] of [
  ['extraCache', 'extraCache'],
  ['extraCookies', 'extraCookies'],
  ['extraDownloads', 'extraDownloads'],
  ['extraFormData', 'extraFormData'],
]) {
  $(id).addEventListener('change', async () => {
    const wantsOn = $(id).checked;
    if (wantsOn && key === 'extraCookies') {
      const ok = window.confirm(
        'Clear cookies and site data?\n\n' +
          'Cookies are removed for the whole registrable domain, so every login on that site ends, not just the ' +
          'page you were on. Site storage (local storage, IndexedDB, service workers) goes with them, because ' +
          'clearing one without the other leaves a site half logged in and half not.\n\n' +
          'This never runs while you browse. It runs when you press a button, and at close or start only if you ' +
          'set that below.'
      );
      if (!ok) {
        $(id).checked = false;
        return;
      }
    }
    state.settings[key] = wantsOn;
    await saveState({ settings: state.settings });
    renderExtras();
  });
}

$('extraSince').addEventListener('change', async () => {
  state.settings.extraSince = $('extraSince').value;
  await saveState({ settings: state.settings });
  renderExtras();
});

$('extraTrigger').addEventListener('change', async () => {
  state.settings.extraTrigger = $('extraTrigger').value;
  await saveState({ settings: state.settings });
  renderExtras();
});

$('extraNowBtn').addEventListener('click', () => {
  const reach = EXTRA_SINCE_LABELS[state.settings.extraSince] || state.settings.extraSince;
  if (!window.confirm(`Clear ${describeExtras(state.settings)} now, covering ${reach}?`)) {
    setMsg($('extraMsg'), 'Cancelled, nothing was cleared.');
    return;
  }
  setMsg($('extraMsg'), 'Clearing…');
  chrome.runtime.sendMessage({ type: 'clearExtra' }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('extraMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('extraMsg'), (res && res.error) || 'The clear failed.', 'err');
      return;
    }
    setMsg(
      $('extraMsg'),
      `Cleared ${res.kinds} (${EXTRA_SINCE_LABELS[res.since] || res.since}). Chrome reports no count, so there is none to show.`,
      'ok'
    );
    load();
  });
});

$('ruleType').addEventListener('change', syncRuleTypeUi);

$('wipeAll').addEventListener('change', async () => {
  const wantsOn = $('wipeAll').checked;
  if (wantsOn) {
    const ok = window.confirm(
      'Arm the whole-history wipe?\n\n' +
        'Every trigger will then erase your entire browsing history instead of only matching your rules. ' +
        'Each wipe still has to be confirmed twice on its own, and arming this does not erase anything by itself.\n\n' +
        'This is history only. Cookies, cache and downloads answer to the "Also clear" switches above.'
    );
    if (!ok) {
      $('wipeAll').checked = false;
      return;
    }
  }
  state.settings.wipeAllHistory = wantsOn;
  await saveState({ settings: state.settings });
  renderSettings();
});

$('keepOnly').addEventListener('change', async () => {
  const wantsOn = $('keepOnly').checked;
  if (wantsOn) {
    if (!activeRules(state.rules).length) {
      $('keepOnly').checked = false;
      setMsg($('keepWarn'), MESSAGES.keepListEmpty, 'warn');
      return;
    }
    if (!window.confirm(MESSAGES.keepListConfirm)) {
      $('keepOnly').checked = false;
      return;
    }
  }
  state.settings.listMode = wantsOn ? 'allow' : 'block';
  await saveState({ settings: state.settings });
  renderSettings();
  runTest();
});

$('lockEnabled').addEventListener('change', async () => {
  const wantsOn = $('lockEnabled').checked;
  const configured = isLockConfigured(state.settings);
  if (!wantsOn && configured) {
    // Switching the lock off is itself a locked action.
    $('lockEnabled').checked = true;
    showUnlock('remove', 'Type your PIN to switch the lock off.');
    return;
  }
  if (!wantsOn) {
    state.settings = mergeSettings({ ...state.settings, lockEnabled: false });
    await saveState({ settings: state.settings });
    setMsg($('lockMsg'), '', 'mini');
    applyLock();
    return;
  }
  applyLock(); // reveals the two PIN boxes
});

$('lockSave').addEventListener('click', async () => {
  const problem = pinProblem($('lockPin1').value, $('lockPin2').value);
  if (problem) {
    setMsg($('lockMsg'), problem, 'err');
    return;
  }
  const record = await makePinRecord($('lockPin1').value);
  state.settings = mergeSettings({ ...state.settings, lockEnabled: true, ...record });
  await saveState({ settings: state.settings });
  $('lockPin1').value = '';
  $('lockPin2').value = '';
  // Saving a PIN hides the list straight away. Waiting for the next reload is how
  // a working lock looks broken.
  unlocked = false;
  pinIntent = 'unlock';
  await load();
  setMsg($('lockMsg'), LOCK_MESSAGES.saved, 'ok');
});

$('lockNowBtn').addEventListener('click', async () => {
  unlocked = false;
  await load();
  setMsg($('lockMsg'), 'Hidden. The list comes back when you type the PIN.', 'ok');
});

$('lockUnlock').addEventListener('click', async () => {
  const { fails, lastFailAt } = await readAttempts();
  const gate = attemptState(fails, lastFailAt, Date.now());
  if (gate.blocked) {
    setMsg($('lockMsg'), LOCK_MESSAGES.lockedOut(Math.ceil(gate.waitMs / 1000)), 'err');
    return;
  }
  const ok = await verifyPin($('lockPin').value, state.settings);
  $('lockPin').value = '';
  if (!ok) {
    const next = fails + 1;
    await writeAttempts(next, Date.now());
    const left = MAX_ATTEMPTS - next;
    setMsg(
      $('lockMsg'),
      left > 0 ? LOCK_MESSAGES.wrongLeft(left) : LOCK_MESSAGES.lockedOut(Math.ceil(LOCKOUT_MS / 1000)),
      'err'
    );
    return;
  }
  const wasRemove = pinIntent === 'remove';
  await writeAttempts(0, 0);
  if (wasRemove) {
    state.settings = mergeSettings({
      ...state.settings,
      lockEnabled: false,
      lockHash: '',
      lockSalt: '',
      lockIterations: 0,
    });
    await saveState({ settings: state.settings });
  }
  unlocked = true;
  pinIntent = 'unlock';
  await load();
  setMsg($('lockMsg'), wasRemove ? LOCK_MESSAGES.removed : LOCK_MESSAGES.open, 'ok');
});

$('lockForgot').addEventListener('click', () => {
  $('lockForgotRow').classList.add('hidden');
  $('lockRecoverRow').classList.remove('hidden');
  setMsg($('lockRecoveryNote'), LOCK_MESSAGES.recoveryLead, 'warn');
  $('lockRecovery').focus();
});

$('lockRecoverBtn').addEventListener('click', async () => {
  if (!checkRecovery($('lockRecovery').value)) {
    setMsg($('lockRecoveryNote'), LOCK_MESSAGES.recoveryWrong, 'err');
    return;
  }
  await factoryReset();
  unlocked = true;
  pinIntent = 'unlock';
  await load();
  setMsg($('lockMsg'), LOCK_MESSAGES.recoveryDone, 'ok');
});

$('addBtn').addEventListener('click', async () => {
  const result = buildRule({
    type: $('ruleType').value,
    value: $('ruleValue').value,
    includeSubdomains: $('includeSubdomains').checked,
    wholeWord: $('wholeWord').checked,
  });
  if (!result.ok) {
    setMsg($('addMsg'), result.error, 'err');
    return;
  }
  state.rules.push(result.rule);
  await saveState({ rules: state.rules });
  $('ruleValue').value = '';
  setMsg($('addMsg'), result.warning || `Added: ${describeRule(result.rule)}`, result.warning ? 'warn' : 'ok');
  renderRules();
  runTest();
});

$('ruleValue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('addBtn').click();
});

$('testUrl').addEventListener('input', runTest);
$('testTitle').addEventListener('input', runTest);

$('wipeNowBtn').addEventListener('click', () => {
  runAction('wipeNow').catch(() => {});
});
$('previewBtn').addEventListener('click', () => {
  runAction('preview').catch(() => {});
});

/**
 * Two gates for the whole-history wipe (a typed phrase, then a final dialog), one
 * for the rule-based wipe. Preview never asks.
 */
async function confirmDestructive() {
  if (state.settings.wipeAllHistory) {
    const gate = await doubleConfirm({
      askPhrase: () => window.prompt(MESSAGES.wipeAllStep1),
      finalConfirm: () => window.confirm(MESSAGES.wipeAllConfirm),
    });
    if (!gate.ok) {
      setMsg(
        $('sweepMsg'),
        gate.reason === 'phrase-mismatch'
          ? `The phrase did not match, so nothing was wiped. It must read exactly: ${WIPE_ALL_PHRASE}`
          : 'Cancelled, nothing was wiped.',
        'warn'
      );
    }
    return gate.ok;
  }

  const gate = await singleConfirm(() => window.confirm(MESSAGES.wipeNowConfirm));
  if (!gate.ok) setMsg($('sweepMsg'), 'Cancelled, nothing was wiped.');
  return gate.ok;
}

async function runAction(type) {
  const isPreview = type === 'preview';

  if (!isPreview && !(await confirmDestructive())) return;

  setMsg($('sweepMsg'), isPreview ? 'Looking for matches…' : 'Wiping…');
  $('previewList').innerHTML = '';
  chrome.runtime.sendMessage({ type }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('sweepMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('sweepMsg'), (res && res.error) || 'Run failed.', 'err');
      return;
    }

    if (isPreview) {
      setMsg(
        $('sweepMsg'),
        res.matched
          ? res.wipeAll
            ? `Wipe-all is armed: all ${res.scanned} entries would be erased.`
            : state.settings.listMode === 'allow'
              ? `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} not on your keep list would be wiped.`
              : `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} would be wiped (scanned ${res.scanned}).`
          : `Nothing would be wiped after scanning ${res.scanned} entries.`,
        res.matched ? 'ok' : 'mini'
      );
    } else if (res.wipeAll) {
      setMsg($('sweepMsg'), `Erased ${res.deleted} entries, the entire history.`, 'ok');
    } else {
      setMsg($('sweepMsg'), `Scanned ${res.scanned}, wiped ${res.deleted}.`, res.deleted ? 'ok' : 'mini');
    }

    // The extra clear cannot be counted, so it is reported by name only.
    if (res.extra) {
      if (res.extra.ok) {
        setMsg(
          $('extraMsg'),
          `Also cleared ${res.extra.kinds} (${EXTRA_SINCE_LABELS[res.extra.since] || res.extra.since}). Chrome reports no count.`,
          'ok'
        );
      } else {
        setMsg($('extraMsg'), `Extra clear skipped: ${res.extra.error}`, 'warn');
      }
    }

    renderPreview(res.sample || []);
    if (!isPreview && res.deleted) load();
  });
}

function renderPreview(sample) {
  const list = $('previewList');
  list.innerHTML = '';
  if (!sample.length) return;
  const head = document.createElement('div');
  head.className = 'row mini';
  head.style.marginTop = '10px';
  head.textContent = sample.length >= 25 ? 'First 25 matches:' : 'Matches:';
  list.appendChild(head);

  for (const item of sample) {
    const row = document.createElement('div');
    row.className = 'logline';
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = item.url;
    const r = document.createElement('span');
    r.className = 'r';
    r.textContent = item.rule;
    row.append(u, r);
    list.appendChild(row);
  }
}

$('clearLog').addEventListener('click', async () => {
  if (!window.confirm(MESSAGES.clearLogConfirm)) return;
  state.log = [];
  await saveState({ log: [] });
  renderLog();
});

$('exportBtn').addEventListener('click', () => {
  const payload = JSON.stringify(
    { app: 'lil-bro-history-wipe', version: 1, settings: state.settings, rules: state.rules },
    null,
    2
  );
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lil-bro-rules.json';
  a.click();
  URL.revokeObjectURL(url);
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(incoming)) throw new Error('No rules array in that file.');
    if (!window.confirm(MESSAGES.importConfirm(incoming.length))) {
      setMsg($('importMsg'), 'Import cancelled, so no rules were added.');
      e.target.value = '';
      return;
    }
    let added = 0;
    let skipped = 0;
    for (const raw of incoming) {
      const result = buildRule({
        type: raw.type,
        value: raw.value,
        includeSubdomains: !!raw.includeSubdomains,
        wholeWord: !!raw.wholeWord,
      });
      if (result.ok) {
        result.rule.enabled = raw.enabled !== false;
        state.rules.push(result.rule);
        added++;
      } else {
        skipped++;
      }
    }
    if (data && data.settings) {
      state.settings = mergeSettings({ ...state.settings, ...data.settings });
      await saveState({ settings: state.settings });
    }
    await saveState({ rules: state.rules });
    setMsg($('importMsg'), `Imported ${added} rule(s)${skipped ? `, skipped ${skipped}` : ''}.`, 'ok');
    renderSettings();
    renderExtras();
    renderRules();
    runTest();
  } catch (err) {
    setMsg($('importMsg'), `Import failed: ${err.message}`, 'err');
  }
  e.target.value = '';
});

// --- presets ---------------------------------------------------------------

for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', async () => {
    const name = btn.dataset.preset;
    if (name === 'custom') {
      state.settings.preset = 'custom';
      await saveState({ settings: state.settings });
      renderExtras();
      return;
    }
    const patch = presetPatch(name);
    if (!patch) return;
    if (name === 'nuclear' || patch.extraCookies) {
      const ok = window.confirm(
        name === 'nuclear'
          ? 'Nuclear clears cache, cookies, saved form text, download history and all of your browsing history.\n\nEvery trigger will do that. Continue?'
          : 'This clears cookies and site data with each run. Logins on those sites end. Continue?'
      );
      if (!ok) return;
    }
    Object.assign(state.settings, patch);
    await saveState({ settings: state.settings });
    renderSettings();
    renderExtras();
    renderStats();
  });
}

// --- cookies ---------------------------------------------------------------

$('cookieKeep').addEventListener('change', async () => {
  state.settings.cookieKeep = parseCookieKeep($('cookieKeep').value);
  await saveState({ settings: state.settings });
  renderCookies();
});

for (const id of ['cookiesOnStart', 'cookiesOnTabClose']) {
  $(id).addEventListener('change', async () => {
    const wantsOn = $(id).checked;
    if (wantsOn && !window.confirm('Clear cookies for every site except your keep list? Logins elsewhere end.')) {
      $(id).checked = false;
      return;
    }
    state.settings[id] = wantsOn;
    if (id === 'cookiesOnTabClose' && wantsOn) {
      const granted = await askTabs();
      if (!granted) {
        state.settings.cookiesOnTabClose = false;
        $(id).checked = false;
        setMsg($('cookiesWarn'), 'Tab access was refused, so this stays off.', 'err');
      }
    }
    await saveState({ settings: state.settings });
    renderCookies();
  });
}

/** The tabs permission is optional, so Chrome asks here and nowhere else. */
async function askTabs() {
  if (!chrome.permissions) return false;
  try {
    if (await chrome.permissions.contains({ permissions: ['tabs'] })) return true;
    return await chrome.permissions.request({ permissions: ['tabs'] });
  } catch {
    return false;
  }
}

$('tabsPermBtn').addEventListener('click', async () => {
  const granted = await askTabs();
  setMsg($('cookieMsg'), granted ? 'Tab access granted.' : 'Tab access refused.', granted ? 'ok' : 'err');
});

$('cookieNowBtn').addEventListener('click', () => {
  const kept = (state.settings.cookieKeep || []).length;
  const ask = kept
    ? `Clear cookies for everything except your ${kept} kept site(s)?`
    : 'Clear every cookie in this browser?';
  if (!window.confirm(ask)) {
    setMsg($('cookieMsg'), 'Cancelled.');
    return;
  }
  setMsg($('cookieMsg'), 'Clearing…');
  chrome.runtime.sendMessage({ type: 'pruneCookies' }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('cookieMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('cookieMsg'), (res && res.error) || 'The clear failed.', 'err');
      return;
    }
    setMsg($('cookieMsg'), res.removed ? `Cleared ${res.removed} cookies.` : 'Nothing to clear.', 'ok');
    load();
  });
});

// --- themes ----------------------------------------------------------------

function applyTheme(name) {
  const theme = name || 'auto';
  document.documentElement.dataset.theme = theme;
  for (const btn of document.querySelectorAll('.theme')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme));
  }
}

for (const btn of document.querySelectorAll('.theme')) {
  btn.addEventListener('click', async () => {
    state.settings.theme = btn.dataset.theme;
    await saveState({ settings: state.settings });
    applyTheme(btn.dataset.theme);
  });
}

getState().then((s) => applyTheme(s.settings.theme));

applyI18n();
syncRuleTypeUi();
load();
