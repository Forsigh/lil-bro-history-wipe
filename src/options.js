// Lil Bro: options page

import {
  getState,
  saveState,
  mergeSettings,
  buildRule,
  splitRuleValues,
  parseExport,
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
import { applyI18n, currentLang, setLang, t } from './i18n.js';
import { findMatch } from './matcher.js';
import { whyLine, headline, hostLabel, shorten } from './logtext.js';
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

// Dates and times follow the language the page is showing, not the browser's, or a Polish
// page prints "10:12 PM".
function fmtWhen(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString(currentLang());
}

// The strip has one line to spend. A run today reads as "today 21:43", an older one as a
// date and a time, and neither carries seconds: toLocaleString() does, and in a summary
// line that reads as noise.
function fmtShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) {
    return (t('glanceToday') || 'today') + ' ' + time;
  }
  return d.toLocaleDateString(currentLang(), { day: 'numeric', month: 'short' }) + ' ' + time;
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
    'Lil Bro v' +
    chrome.runtime.getManifest().version +
    (t('optStatusLine') || ': everything you add stays on this computer.');
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
  // Preview prints the URLs it matched, so it stays shut while locked. The tester
  // answers with a rule name, so it does the same, inputs included.
  $('lockForgotRow').classList.toggle('hidden', !locked);
  if (!locked) $('lockRecoverRow').classList.add('hidden');
  $('previewBtn').disabled = locked;
  $('previewList').classList.toggle('hidden', locked);
  $('testUrl').disabled = locked;
  $('testTitle').disabled = locked;
}

function showUnlock(intent, message) {
  pinIntent = intent;
  $('lockUnlockRow').classList.remove('hidden');
  setMsg($('lockMsg'), message, 'warn');
  $('lockPin').focus();
}

function renderSettings() {
  const s = state.settings;
  // "When I close the browser" is gone from the page: it could not run at the exact
  // moment of close, so anyone still on it moves to the next start, which it also did.
  if (s.mode === 'onclose') {
    s.mode = 'startup';
    saveState({ settings: s });
  }
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.checked = input.value === s.mode;
  }
  $('sweep').checked = !!s.sweepExistingOnStartup;
  $('notify').checked = !!s.notifyOnWipe;
  $('logEnabled').checked = !!s.logEnabled;
  $('wipeAll').checked = !!s.wipeAllHistory;
  $('keepOnly').checked = s.listMode === 'allow';
  $('lockEnabled').checked = !!s.lockEnabled;
  $('advOn').checked = !!s.advanced;
  // Locked, the way out sits in here, so the box opens rather than hiding itself. And the
  // switch says how many controls it is holding back.
  $('advBox').classList.toggle('hidden', !(s.advanced || isLocked()));
  const held = $('advBox').querySelectorAll('button, input, select, textarea').length;
  $('advLabel').textContent = t('optAdvanced') + ' ' + t('advCount', [held]);
  $('langPick').value = s.lang || 'auto';
  $('keepWarn').textContent = s.listMode === 'allow'
    ? t('optKeepWarn') || 'On: everything not on your list is being wiped. Cookies and cache are separate.'
    : '';
  $('wipeNowBtn').textContent = s.wipeAllHistory ? t('wipeAllNow') || 'Wipe ALL history now' : t('wipeNow') || 'Wipe now';
  $('wipeAllWarn').textContent = s.wipeAllHistory
    ? t('optWipeAllArmed') ||
      'ARMED: the entire history is erased on every trigger above, and "Wipe now" empties it immediately.'
    : t('optWipeAllOff') || 'Off by default. Your rules are still being applied.';

  const enabled = s.enabled;
  const dot = 'dot' + (enabled ? '' : ' off') + (s.wipeAllHistory ? ' danger' : '');
  $('stateDot').className = dot;
  $('glanceDot').className = dot;
  // From the bundle. These were English literals, so a Polish page read
  // "Aktywne: wiping on visit" and nothing caught it: no key was missing.
  const modeText = {
    realtime: t('stateOnVisit') || 'wiping on visit',
    onclose: t('stateAtClose') || 'wiping at browser close',
    startup: t('stateAtStart') || 'wiping at browser start',
  }[s.mode] || s.mode;
  const stateLine = s.wipeAllHistory
    ? enabled
      ? t('stateArmed') || 'ARMED: wiping ALL history'
      : t('statePaused') || 'Paused'
    : !enabled
      ? t('statePaused') || 'Paused'
      : s.listMode === 'allow'
        ? t('stateKeep') || 'Active: wiping all but your keep list'
        : t('stateActive', [modeText]) || `Active: ${modeText}`;
  // The same line twice on purpose: once at the top where it answers the question
  // someone came with, once in the status card beside the counters.
  $('stateText').textContent = stateLine;
  $('glanceState').textContent = stateLine;
  $('glanceRules').textContent =
    (t('glanceOnYourList') || 'On your list') + ': ' + (state.rules || []).length;
  const totalKept = (state.stats && state.stats.wipedTotal) || 0;
  $('glanceTotal').textContent = t('glanceTotal', [totalKept.toLocaleString(currentLang())]);
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
        ? t('optWhenManual') || 'only when you press a button'
        : t('optWhenBoth') || 'on a button, and again when the browser closes or starts';
    setMsg($('extraWarn'), t('optExtraLine', [kinds, reach, when]) || `On: ${kinds}, covering ${reach}, ${when}.`, 'warn');
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
    off: t('optPresetOffNote') || 'History only, following your rules. Nothing else is touched.',
    light: t('optPresetLightNote') || 'Cache goes with each run, so pages will load a little slower.',
    standard:
      t('optPresetStandardNote') ||
      'Cache and cookies go with each run. Sites will not remember you, so you may have to log in again.',
    nuclear:
      t('optPresetNuclearNote') ||
      'Cache, cookies, saved form text, download history and all of your history, at every trigger.',
    custom: t('optPresetCustomNote') || 'Your own mix of the four switches.',
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
      ? t('optCookiesWarnOn') ||
          'Cookies are deleted for every site except the list below, so logins everywhere else end.'
      : t('optCookiesWarnOff') ||
          'Off. Cookies are only cleared if you turn on the cookie switch in Clearing above, or press the button below.'
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
    tdType.textContent =
      t(`rule${rule.type[0].toUpperCase()}${rule.type.slice(1)}`) || RULE_TYPES[rule.type] || rule.type;
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
    const removed = (state.stats && state.stats.byRule && state.stats.byRule[rule.id]) || 0;
    if (removed > 0) {
      const count = document.createElement('span');
      count.className = 'tag';
      count.textContent = t('ruleRemoved', String(removed));
      tdValue.appendChild(count);
    }
    tr.appendChild(tdValue);

    const keep = document.createElement('button');
    keep.className = 'tag keep' + (rule.exempt ? ' on' : '');
    keep.setAttribute('aria-pressed', rule.exempt ? 'true' : 'false');
    keep.textContent = t('ruleNeverDelete');
    keep.addEventListener('click', async () => {
      rule.exempt = rule.exempt !== true;
      await saveState({ rules: state.rules });
      renderRules();
      runTest();
    });
    tdValue.appendChild(keep);

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
    ? t('lastRunAt', [fmtWhen(st.lastRunAt), st.lastRunPhase || 'run']) ||
      `Last run: ${fmtWhen(st.lastRunAt)} (${st.lastRunPhase || 'run'})`
    : t('optLastRunNone') || 'No runs yet.';

  const last = $('glanceLast');
  last.textContent = st.lastRunAt
    ? (t('glanceLastRun') || 'Last clean') + ': ' + fmtShort(st.lastRunAt)
    : '';
  last.classList.toggle('hidden', !st.lastRunAt);

  const queued = (state.pending || []).length;
  const when =
    state.settings.mode === 'onclose'
      ? t('queueWhenClose') || 'when you close the browser'
      : t('queueWhenStart') || 'at your next start';
  $('queueInfo').textContent =
    state.settings.mode === 'realtime' ? '' : t('queueLine', [String(queued), when]) || `${queued} queued, wiped ${when}.`;
}

/**
 * What was cleaned, said the way a person reads it: the page title first, then the
 * reason in words, then when it happened and where. Entries written by an older build
 * have only the rule string, so they still show that rather than nothing.
 */
function renderLog() {
  const list = $('logList');
  list.innerHTML = '';
  const entries = state.log || [];
  $('logEmpty').classList.toggle('hidden', entries.length > 0);

  for (const e of entries.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'logline';

    const head = document.createElement('span');
    head.className = 'h';
    const named = headline(e);
    head.textContent = named ? t('logFound', [named]) || `Found “${named}”` : '';
    head.title = [e.title, e.url].filter(Boolean).join('\n');

    const why = document.createElement('span');
    why.className = 'w';
    why.textContent = whyLine(t, e);

    const meta = document.createElement('span');
    meta.className = 'm';
    const when = document.createElement('span');
    when.textContent = fmtWhen(e.at);
    const host = document.createElement('span');
    host.className = 'a';
    host.textContent = hostLabel(e.url);
    const detail = document.createElement('code');
    detail.textContent = e.excerpt || shorten(e.url, 72);
    detail.title = e.url;
    meta.append(when, host, detail);

    row.append(head, why, meta);
    list.appendChild(row);
  }
}

function runTest() {
  // The tester answers with the name of the rule that matched, which is exactly
  // what the lock keeps off this page. So while the PIN is on it says nothing.
  if (isLocked()) {
    setMsg($('testOut'), '');
    return;
  }
  const url = $('testUrl').value.trim();
  const title = $('testTitle').value.trim();
  if (!url && !title) {
    setMsg($('testOut'), t('optTestNothing') || 'Nothing tested yet.');
    return;
  }
  const live = activeRules(state.rules);
  const keep = state.settings.listMode === 'allow';
  if (!live.length) {
    setMsg(
      $('testOut'),
      keep
        ? t('optTestKeepEmpty') || 'The keep list is empty, so nothing is wiped.'
        : t('optTestNoRules') || 'No active rules, so nothing would be wiped.',
      'warn'
    );
    return;
  }
  const rule = findMatch({ url, title }, live);
  if (keep) {
    setMsg(
      $('testOut'),
      rule
        ? t('optTestKept') || 'Kept: this page is on your keep list.'
        : t('optTestNotKept') || 'Not on your keep list, so this would be wiped.',
      rule ? 'ok' : 'warn'
    );
    return;
  }
  if (rule) {
    const typeName = t(`rule${rule.type[0].toUpperCase()}${rule.type.slice(1)}`) || RULE_TYPES[rule.type] || rule.type;
    setMsg($('testOut'), t('wouldBeWiped', [typeName, describeRule(rule)]) || `Would be wiped by: ${typeName} → ${describeRule(rule)}`, 'ok');
  } else {
    setMsg($('testOut'), t('optTestNoMatch') || 'No rule matches this, so it stays in history.', 'mini');
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
$('advOn').addEventListener('change', async () => {
  state.settings.advanced = $('advOn').checked;
  $('advBox').classList.toggle('hidden', !(state.settings.advanced || isLocked()));
  await saveState({ settings: state.settings });
});
// Switching the language reloads the page: every string, including the ones the
// script writes, has to come out in the new one.
$('langPick').addEventListener('change', async () => {
  state.settings.lang = $('langPick').value;
  await saveState({ settings: state.settings });
  location.reload();
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
        t('optCookieConfirm') ||
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
  if (
    !window.confirm(
      t('optClearNowAsk', [describeExtras(state.settings), reach]) ||
        `Clear ${describeExtras(state.settings)} now, covering ${reach}?`
    )
  ) {
    setMsg($('extraMsg'), t('optCancelledClear') || 'Cancelled, nothing was cleared.');
    return;
  }
  setMsg($('extraMsg'), t('msgClearing') || 'Clearing…');
  chrome.runtime.sendMessage({ type: 'clearExtra' }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('extraMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('extraMsg'), (res && res.error) || t('errClearFailed') || 'The clear failed.', 'err');
      return;
    }
    setMsg(
      $('extraMsg'),
      t('resClearedNoCountOpt', [res.kinds, EXTRA_SINCE_LABELS[res.since] || res.since]) ||
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
      t('optWipeAllConfirm') ||
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
    showUnlock('remove', t('optLockOffPin') || 'Type your PIN to switch the lock off.');
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
  setMsg($('lockMsg'), t('optLockHidden') || 'Hidden. The list comes back when you type the PIN.', 'ok');
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

// The suggestions. Read on request, ranked on screen, and added through the same path
// as anything else, so there is no second way to write a rule.
function renderInsights(items) {
  const box = $('insightsList');
  box.textContent = '';
  if (!items.length) {
    const line = document.createElement('div');
    line.className = 'row mini';
    line.textContent = t('optInsightsEmpty');
    const go = document.createElement('button');
    go.className = 'ghost';
    go.textContent = t('optInsightsEmptyAction');
    go.addEventListener('click', () => {
      $('ruleValue').focus();
      $('ruleValue').scrollIntoView({ block: 'center' });
    });
    box.append(line, go);
    return;
  }
  for (const row of items) {
    const line = document.createElement('div');
    line.className = 'row';
    const site = document.createElement('span');
    site.className = 'grow';
    site.textContent = row.host;
    const count = document.createElement('span');
    count.className = 'mini';
    count.textContent = t('optInsightsVisits', String(row.visits));
    const add = document.createElement('button');
    add.className = 'ghost';
    add.textContent = t('optInsightsAdd');
    add.addEventListener('click', () => {
      $('ruleType').value = 'domain';
      $('ruleValue').value = row.host;
      $('addBtn').click();
      add.disabled = true;
      add.textContent = t('optInsightsAdded');
    });
    line.append(site, count, add);
    box.append(line);
  }
}

$('insightsBtn').addEventListener('click', () => {
  const msg = $('insightsMsg');
  msg.textContent = t('optInsightsWorking');
  const restore = msg.textContent;
  chrome.runtime.sendMessage({ type: 'insights' }, (res) => {
    if (!res || !res.ok) {
      msg.textContent = t('optInsightsFailed');
      return;
    }
    msg.textContent = '';
    renderInsights(res.items || []);
    if (!restore) msg.textContent = '';
  });
});

$('addBtn').addEventListener('click', async () => {
  const type = $('ruleType').value;
  const values = splitRuleValues(type, $('ruleValue').value);
  if (!values.length) {
    setMsg($('addMsg'), t('errNoValue') || 'Enter a value first.', 'err');
    return;
  }
  const made = [];
  let warning = '';
  let skipped = 0;
  let firstError = '';
  for (const value of values) {
    const result = buildRule({
      type,
      value,
      includeSubdomains: $('includeSubdomains').checked,
      wholeWord: $('wholeWord').checked,
    });
    if (!result.ok) {
      skipped += 1;
      firstError = firstError || result.error;
      continue;
    }
    const listed = state.rules.some(
      (r) => r.type === result.rule.type && r.value === result.rule.value
    );
    if (listed || made.some((r) => r.value === result.rule.value)) {
      skipped += 1;
      continue;
    }
    made.push(result.rule);
    warning = warning || result.warning || '';
  }
  if (made.length) {
    state.rules.push(...made);
    await saveState({ rules: state.rules });
  }
  $('ruleValue').value = '';
  // One value behaves as it always did: the new row appearing in the list is the
  // confirmation, and a line repeating it is noise. A pasted list says how much of
  // it landed, and names the first value that could not be used. While the lock is
  // on the page may not name what was added, so it says the bare word the popup says.
  let msg = '';
  let kind = 'mini';
  if (values.length > 1) {
    msg = t('addedMany', [made.length, skipped]) || `Added ${made.length} to the list, skipped ${skipped}.`;
    if (skipped && firstError) msg += ` ${firstError}`;
    kind = skipped ? 'warn' : 'ok';
  } else if (made.length) {
    msg = warning || (isLocked() ? t('addedOnly') || 'Added.' : '');
    kind = warning ? 'warn' : 'ok';
  } else {
    msg = firstError;
    kind = 'err';
  }
  setMsg($('addMsg'), msg, msg ? kind : 'mini');
  renderRules();
  runTest();
});

// Enter adds, Shift+Enter starts a new line: the field takes a pasted list, so a
// second line sometimes has to be typed by hand.
$('ruleValue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('addBtn').click();
  }
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
          ? t('errPhraseMismatch', [WIPE_ALL_PHRASE]) ||
            `The phrase did not match, so nothing was wiped. It must read exactly: ${WIPE_ALL_PHRASE}`
          : t('optCancelledWipe') || 'Cancelled, nothing was wiped.',
        'warn'
      );
    }
    return gate.ok;
  }

  const gate = await singleConfirm(() => window.confirm(MESSAGES.wipeNowConfirm));
  if (!gate.ok) setMsg($('sweepMsg'), t('optCancelledWipe') || 'Cancelled, nothing was wiped.');
  return gate.ok;
}

async function runAction(type) {
  const isPreview = type === 'preview';

  if (!isPreview && !(await confirmDestructive())) return;

  setMsg($('sweepMsg'), isPreview ? t('msgLooking') || 'Looking for matches…' : t('msgWiping') || 'Wiping…');
  $('previewList').innerHTML = '';
  chrome.runtime.sendMessage({ type }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('sweepMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('sweepMsg'), (res && res.error) || t('errRunFailed') || 'Run failed.', 'err');
      return;
    }

    if (isPreview) {
      setMsg(
        $('sweepMsg'),
        res.matched
          ? res.wipeAll
            ? t('resArmedAll', [res.scanned]) ||
              `Wipe-all is armed: all ${res.scanned} entries would be erased.`
            : state.settings.listMode === 'allow'
              ? t('resKeepWould', [res.matched]) ||
                `Entries not on your keep list that would be wiped: ${res.matched}.`
              : t('resWould', [res.matched, res.scanned]) ||
                `Entries that would be wiped: ${res.matched} (scanned ${res.scanned}).`
          : t('resNothing', [res.scanned]) ||
            `Nothing would be wiped after scanning ${res.scanned} entries.`,
        res.matched ? 'ok' : 'mini'
      );
    } else if (res.wipeAll) {
      setMsg(
        $('sweepMsg'),
        t('resErasedAll', [res.deleted]) || `Erased ${res.deleted} entries, the entire history.`,
        'ok'
      );
    } else {
      setMsg(
        $('sweepMsg'),
        t('resScannedWiped', [res.scanned, res.deleted]) || `Scanned ${res.scanned}, wiped ${res.deleted}.`,
        res.deleted ? 'ok' : 'mini'
      );
    }

    // The extra clear cannot be counted, so it is reported by name only.
    if (res.extra) {
      if (res.extra.ok) {
        setMsg(
          $('extraMsg'),
          t('resAlsoCleared', [res.extra.kinds, EXTRA_SINCE_LABELS[res.extra.since] || res.extra.since]) ||
            `Also cleared ${res.extra.kinds} (${EXTRA_SINCE_LABELS[res.extra.since] || res.extra.since}). Chrome reports no count.`,
          'ok'
        );
      } else {
        setMsg($('extraMsg'), t('resExtraSkipped', [res.extra.error]) || `Extra clear skipped: ${res.extra.error}`, 'warn');
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
  head.textContent =
    sample.length >= 25
      ? t('resFirst25') || 'First 25 matches:'
      : t('resMatches') || 'Matches:';
  list.appendChild(head);

  for (const item of sample) {
    const row = document.createElement('div');
    row.className = 'logline';
    const title = document.createElement('span');
    title.className = 'h';
    title.textContent = headline(item);
    const why = document.createElement('span');
    why.className = 'w';
    why.textContent = whyLine(t, item);
    const meta = document.createElement('span');
    meta.className = 'm';
    const host = document.createElement('span');
    host.className = 'a';
    host.textContent = hostLabel(item.url);
    meta.append(host);
    row.append(title, why, meta);
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
    const incoming = parseExport(await file.text());
    if (!window.confirm(MESSAGES.importConfirm(incoming.rules.length + incoming.skipped))) {
      setMsg($('importMsg'), t('optImportCancelled') || 'Import cancelled, so no rules were added.');
      e.target.value = '';
      return;
    }
    for (const rule of incoming.rules) state.rules.push(rule);
    if (incoming.settings) {
      state.settings = mergeSettings({ ...state.settings, ...incoming.settings });
      await saveState({ settings: state.settings });
    }
    await saveState({ rules: state.rules });
    setMsg(
      $('importMsg'),
      (incoming.skipped
        ? t('optImportedSkipped', [incoming.rules.length, incoming.skipped])
        : t('optImported', [incoming.rules.length])) ||
        `Imported ${incoming.rules.length} rule(s)${incoming.skipped ? `, skipped ${incoming.skipped}` : ''}.`,
      'ok'
    );
    renderSettings();
    renderExtras();
    // An imported file can carry a theme with it. Without this the setting lands in
    // storage but the page keeps the old one until a reload, so the import looks
    // like it did nothing.
    applyTheme(state.settings.theme);
    renderRules();
    runTest();
  } catch (err) {
    setMsg($('importMsg'), t('optImportFailed', [err.message]) || `Import failed: ${err.message}`, 'err');
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
          ? t('optNuclearConfirm') ||
              'FULL clears cache, cookies, saved form text, download history and all of your browsing history.\n\nEvery trigger will do that. Continue?'
          : t('optStandardConfirm') ||
              'This clears cookies and site data with each run. Logins on those sites end. Continue?'
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
    if (
      wantsOn &&
      !window.confirm(
        t('optCookieAllConfirm') ||
          'Clear cookies for every site except your keep list? Logins elsewhere end.'
      )
    ) {
      $(id).checked = false;
      return;
    }
    state.settings[id] = wantsOn;
    if (id === 'cookiesOnTabClose' && wantsOn) {
      const granted = await askTabs();
      if (!granted) {
        state.settings.cookiesOnTabClose = false;
        $(id).checked = false;
        setMsg($('cookiesWarn'), t('optTabsRefused') || 'Tab access was refused, so this stays off.', 'err');
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
  setMsg(
    $('cookieMsg'),
    granted ? t('optTabsGranted') || 'Tab access granted.' : t('optTabsRefusedMsg') || 'Tab access refused.',
    granted ? 'ok' : 'err'
  );
});

$('cookieNowBtn').addEventListener('click', () => {
  const kept = (state.settings.cookieKeep || []).length;
  const ask = kept
    ? t('optCookiePruneAsk', [kept]) || `Clear cookies for everything except your ${kept} kept site(s)?`
    : t('optCookieAllAsk') || 'Clear every cookie in this browser?';
  if (!window.confirm(ask)) {
    setMsg($('cookieMsg'), t('optCancelled') || 'Cancelled.');
    return;
  }
  setMsg($('cookieMsg'), t('msgClearing') || 'Clearing…');
  chrome.runtime.sendMessage({ type: 'pruneCookies' }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg($('cookieMsg'), chrome.runtime.lastError.message, 'err');
      return;
    }
    if (!res || !res.ok) {
      setMsg($('cookieMsg'), (res && res.error) || t('errClearFailed') || 'The clear failed.', 'err');
      return;
    }
    setMsg(
      $('cookieMsg'),
      res.removed
        ? t('optCookieCleared', [res.removed]) || `Cleared ${res.removed} cookies.`
        : t('optNothingToClear') || 'Nothing to clear.',
      'ok'
    );
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

// The language has to be settled before anything writes text into the page.
(async () => {
  const initial = await getState();
  await setLang(initial.settings.lang);
  applyTheme(initial.settings.theme);
  applyI18n();
  syncRuleTypeUi();
  await load();
})().catch((err) => {
  // The same reason the popup says why: an uncaught throw here leaves the word "Loading"
  // on the page and every control dead, which reads as a broken extension rather than a
  // failure that has a name.
  const text = $('stateText');
  if (text) text.textContent = t('startFailed') || 'Could not start';
  const glance = $('glanceState');
  if (glance) glance.textContent = t('startFailedHint') || 'Reload the extension on the extensions page.';
  const dot = $('stateDot');
  if (dot) dot.className = 'dot danger';
  console.error('[Lil Bro] the settings page could not start:', err);
});
