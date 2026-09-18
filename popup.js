// Lil Bro: toolbar popup
//
// Two layouts, one set of controls. 'simple' opens with the state, the switch and
// the two runs; everything else sits behind "More controls". 'classic' is the
// denser popup as it was, for anyone who wants it all on screen at once.

import {
  getState,
  saveState,
  buildRule,
  describeRule,
  normalizeDomain,
  readAttempts,
  writeAttempts,
  factoryReset,
  extraOn,
  describeExtras,
  EXTRA_SINCE_LABELS,
} from './store.js';
import {
  checkPhrase,
  secondClickWithin,
  MESSAGES,
  WIPE_ALL_PHRASE,
  ARM_WINDOW_MS,
} from './confirm-gate.js';
import {
  verifyPin,
  isLockConfigured,
  attemptState,
  checkRecovery,
  LOCK_MESSAGES,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
} from './lock.js';
import { applyI18n, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

let state = null;
let currentUrl = '';
let armAt = null;
let phraseOk = false;
let armTimer = null;
// Unlocking lasts as long as the popup is open; the wrong-PIN throttle outlives it.
let unlocked = false;

function setMsg(text, kind = 'mini') {
  const el = $('wipeMsg');
  el.textContent = text || '';
  el.className = 'row ' + kind;
}

function setLockMsg(text, kind = 'mini') {
  const el = $('lockMsg');
  el.textContent = text || '';
  el.className = 'row ' + kind;
}

async function load() {
  state = await getState();
  render();
  applyLock();
  applyLayout(state.settings.popupLayout);
  await loadCurrentTab();
  $('version').textContent = 'Lil Bro v' + chrome.runtime.getManifest().version;
}

/** A PIN is set and this popup has not been unlocked. */
function isLocked() {
  return isLockConfigured(state.settings) && !unlocked;
}

/** Take the parts that would name a site off the screen, and offer the PIN box. */
function applyLock() {
  const locked = isLocked();
  document.body.classList.toggle('locked', locked);
  $('lockCard').classList.toggle('hidden', !locked);
  if (!locked) return;
  $('lockNote').textContent = LOCK_MESSAGES.listHidden;
  $('previewList').innerHTML = '';
  $('wipeMsg').textContent = '';
  setLockMsg('');
}

/**
 * The layout lives in settings, so it survives closing the popup. Nothing that
 * names a site is affected by it: both layouts hold the same controls.
 */
function applyLayout(layout) {
  const classic = layout === 'classic';
  document.body.classList.toggle('layout-classic', classic);
  document.body.classList.toggle('layout-simple', !classic);
  $('layoutBtn').textContent = classic ? 'Compact' : 'Classic';
  $('layoutBtn').title = classic
    ? 'Switch back to the compact popup'
    : 'Switch to the classic popup, with everything on screen';
  if (classic) setMore(true);
}

function setMore(open) {
  const btn = $('moreBtn');
  $('more').classList.toggle('open', !!open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.firstElementChild.textContent = open ? 'Fewer controls' : 'More controls';
}

function render() {
  const s = state.settings;
  const armed = !!s.wipeAllHistory;
  $('dot').className = 'dot' + (s.enabled ? '' : ' off') + (armed ? ' danger' : '');
  const keep = s.listMode === 'allow';
  $('status').textContent = !s.enabled
    ? t('statusPaused') || 'Paused'
    : armed
      ? t('statusArmed') || 'Armed: wiping ALL history'
      : keep
        ? t('statusKeep') || 'Wiping all but your keep list'
        : t('statusActive') || 'Active';

  // The switch carries the state and the control, so there is nothing to read twice.
  const toggle = $('toggleBtn');
  toggle.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
  toggle.querySelector('.switch-label').textContent = s.enabled ? t('switchOn') || 'On' : t('switchOff') || 'Off';
  toggle.title = s.enabled ? t('pauseTitle') || 'Pause Lil Bro' : t('resumeTitle') || 'Start wiping again';

  $('wipeBtn').textContent = armed ? t('wipeAllNow') || 'Wipe ALL history now' : t('wipeNow') || 'Wipe now';
  $('scopeList').checked = !armed;
  $('scopeAll').checked = armed;
  $('addDomainBtn').textContent = keep ? t('keepSite') || 'Keep this site' : t('addSite') || 'Add to filter list';
  $('addUrlBtn').textContent = keep ? t('keepPage') || 'Keep this exact page only' : t('addPage') || 'Add just this page';
  $('wipeAllWarn').textContent = armed
    ? t('wipeAllOn') || 'Wipe-all is ON: your entire history goes, not just your rules.'
    : keep
      ? t('keepOn') || 'Everything not on your list is wiped.'
      : '';
  const modes = {
    realtime: armed
      ? t('modeInstantArmed') || 'Every visit is erased the moment it happens.'
      : t('modeInstant') || 'Wiping instantly, as you browse.',
    onclose: armed
      ? t('modeCloseArmed') || 'Everything goes when you close the browser.'
      : t('modeClose') || 'Matches go when you close the browser.',
    startup: armed
      ? t('modeStartArmed') || 'Everything goes at the start of your next session.'
      : t('modeStart') || 'Matches go at the start of your next session.',
  };
  const keepModes = {
    realtime: t('keepInstant') || 'Every other site is erased as you visit it.',
    onclose: t('keepClose') || 'Everything else goes when you close the browser.',
    startup: t('keepStart') || 'Everything else goes at your next start.',
  };
  $('modeText').textContent = (keep ? keepModes[s.mode] : modes[s.mode]) || '';
  $('statTotal').textContent = state.stats.wipedTotal || 0;
  $('statLast').textContent = state.stats.lastRunCount || 0;
  $('subdomains').checked = !!state.settings.includeSubdomainsDefault;

  // The extra clear, when it is switched on anywhere.
  const extras = extraOn(s);
  $('extraRow').classList.toggle('hidden', !extras);
  if (extras) {
    $('extraBtn').textContent = 'Clear now';
    $('extraLine').textContent = `Also clearing: ${describeExtras(s)}, ${
      EXTRA_SINCE_LABELS[s.extraSince] || s.extraSince
    }.`;
  } else {
    $('extraLine').textContent = 'History only.';
  }

  document.documentElement.dataset.theme = s.theme || 'auto';

  const queued = (state.pending || []).length;
  $('queueInfo').textContent =
    s.mode === 'realtime'
      ? ''
      : `${queued} ${queued === 1 ? 'entry' : 'entries'} queued, wiped ${
          s.mode === 'onclose' ? 'when you close the browser' : 'at your next start'
        }.`;
}

async function loadCurrentTab() {
  if (isLocked()) {
    // The lock is on, so the current tab is not named anywhere in this page.
    $('sitePreview').textContent = LOCK_MESSAGES.listHidden;
    $('addDomainBtn').disabled = true;
    $('addUrlBtn').disabled = true;
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl = (tab && tab.url) || '';
  } catch {
    currentUrl = '';
  }
  const domain = normalizeDomain(currentUrl);
  const usable = /^https?:/i.test(currentUrl) && domain;
  $('sitePreview').textContent = usable ? `Current tab: ${domain}` : 'This tab has no wipeable site.';
  $('addDomainBtn').disabled = !usable;
  $('addUrlBtn').disabled = !usable;
}

function addRule(rule) {
  state.rules.push(rule);
  saveState({ rules: state.rules }).then(() => {
    setMsg(
      state.settings.listMode === 'allow' ? `Keeping ${describeRule(rule)}.` : `Added ${describeRule(rule)}.`,
      'ok'
    );
  });
}

$('toggleBtn').addEventListener('click', async () => {
  state.settings.enabled = !state.settings.enabled;
  await saveState({ settings: state.settings });
  render();
});

$('layoutBtn').addEventListener('click', async () => {
  const next = state.settings.popupLayout === 'classic' ? 'simple' : 'classic';
  state.settings.popupLayout = next;
  applyLayout(next);
  await saveState({ settings: state.settings });
});

$('moreBtn').addEventListener('click', () => {
  setMore(!$('more').classList.contains('open'));
});

$('subdomains').addEventListener('change', async () => {
  state.settings.includeSubdomainsDefault = $('subdomains').checked;
  await saveState({ settings: state.settings });
});

// Two ways to run: just the list, or the whole history. The red one is armed here
// as well as on the options page, and both go through the same confirmation.
$('scopeList').addEventListener('change', async () => {
  if (!$('scopeList').checked) return;
  state.settings.wipeAllHistory = false;
  await saveState({ settings: state.settings });
  render();
});

$('scopeAll').addEventListener('change', async () => {
  if (!$('scopeAll').checked) return;
  if (!window.confirm(MESSAGES.wipeAllArm)) {
    render();
    return;
  }
  state.settings.wipeAllHistory = true;
  await saveState({ settings: state.settings });
  render();
});

$('lockUnlock').addEventListener('click', async () => {
  const { fails, lastFailAt } = await readAttempts();
  const gate = attemptState(fails, lastFailAt, Date.now());
  if (gate.blocked) {
    setLockMsg(LOCK_MESSAGES.lockedOut(Math.ceil(gate.waitMs / 1000)), 'err');
    return;
  }
  const ok = await verifyPin($('lockPin').value, state.settings);
  $('lockPin').value = '';
  if (!ok) {
    const next = fails + 1;
    await writeAttempts(next, Date.now());
    const left = MAX_ATTEMPTS - next;
    setLockMsg(
      left > 0 ? LOCK_MESSAGES.wrongLeft(left) : LOCK_MESSAGES.lockedOut(Math.ceil(LOCKOUT_MS / 1000)),
      'err'
    );
    return;
  }
  unlocked = true;
  await writeAttempts(0, 0);
  await load();
  setLockMsg(LOCK_MESSAGES.open, 'ok');
});

$('lockForgot').addEventListener('click', () => {
  $('forgotRow').classList.add('hidden');
  $('recoverRow').classList.remove('hidden');
  setLockMsg(LOCK_MESSAGES.recoveryLead, 'warn');
  $('lockRecovery').focus();
});

$('lockRecoverBtn').addEventListener('click', async () => {
  if (!checkRecovery($('lockRecovery').value)) {
    setLockMsg(LOCK_MESSAGES.recoveryWrong, 'err');
    return;
  }
  await factoryReset();
  unlocked = true;
  await load();
  setLockMsg(LOCK_MESSAGES.recoveryDone, 'ok');
});

$('addDomainBtn').addEventListener('click', () => {
  const result = buildRule({
    type: 'domain',
    value: normalizeDomain(currentUrl),
    includeSubdomains: $('subdomains').checked,
  });
  if (!result.ok) return setMsg(result.error, 'err');
  addRule(result.rule);
});

$('addUrlBtn').addEventListener('click', () => {
  const result = buildRule({ type: 'url', value: currentUrl });
  if (!result.ok) return setMsg(result.error, 'err');
  addRule(result.rule);
});

$('wipeBtn').addEventListener('click', () => requestRun('wipeNow'));
$('previewBtn').addEventListener('click', () => requestRun('preview'));

/**
 * The extra clear. It cannot report a count, because Chrome does not say how
 * much cache or how many cookies it removed, so the message names what was asked
 * for and stops there.
 */
$('extraBtn').addEventListener('click', () => {
  setMsg('Clearing…');
  chrome.runtime.sendMessage({ type: 'clearExtra' }, (res) => {
    if (chrome.runtime.lastError) return setMsg(chrome.runtime.lastError.message, 'err');
    if (!res || !res.ok) return setMsg((res && res.error) || 'The clear failed.', 'err');
    setMsg(`Cleared ${res.kinds} (${EXTRA_SINCE_LABELS[res.since] || res.since}). Chrome gives no count.`, 'ok');
  });
});

/**
 * Two gates before anything is erased. Wipe-all needs a typed phrase and then a
 * confirming click; the rule-based wipe needs two clicks inside the arm window.
 * Preview never asks.
 */
function requestRun(type) {
  if (type === 'preview') return runAction('preview');

  const armed = !!state.settings.wipeAllHistory;
  const now = Date.now();

  if (armed && !phraseOk) {
    $('phraseRow').classList.remove('hidden');
    setMsg(MESSAGES.wipeAllPhrase);
    $('confirmPhrase').focus();
    return;
  }

  if (armAt === null) {
    armAt = now;
    $('wipeBtn').textContent = armed ? MESSAGES.wipeAllStep2 : MESSAGES.armWipeNow;
    setMsg(armed ? MESSAGES.wipeAllArmed : MESSAGES.wipeNowHint, 'warn');
    armResetLater();
    return;
  }

  if (!secondClickWithin(armAt, now, ARM_WINDOW_MS)) {
    resetArm(MESSAGES.wipeAllTimeout);
    return;
  }

  resetArm();
  runAction('wipeNow');
}

function armResetLater() {
  if (armTimer) clearTimeout(armTimer);
  armTimer = setTimeout(() => resetArm(MESSAGES.wipeAllTimeout), ARM_WINDOW_MS);
}

function resetArm(message) {
  armAt = null;
  phraseOk = false;
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  $('phraseRow').classList.add('hidden');
  $('confirmPhrase').value = '';
  $('wipeBtn').textContent = state.settings.wipeAllHistory ? 'Wipe ALL history now' : 'Wipe now';
  setMsg(message || '');
}

$('confirmPhraseBtn').addEventListener('click', () => {
  if (!checkPhrase($('confirmPhrase').value)) {
    setMsg(`That is not the phrase, so nothing was armed. It must read exactly: ${WIPE_ALL_PHRASE}`, 'err');
    return;
  }
  phraseOk = true;
  armAt = Date.now();
  $('phraseRow').classList.add('hidden');
  $('confirmPhrase').value = '';
  $('wipeBtn').textContent = MESSAGES.wipeAllStep2;
  setMsg(MESSAGES.wipeAllArmed, 'warn');
  armResetLater();
});

function runAction(type) {
  const isPreview = type === 'preview';
  setMsg(isPreview ? 'Looking for matches…' : 'Wiping…');
  $('previewList').innerHTML = '';
  chrome.runtime.sendMessage({ type }, (res) => {
    if (chrome.runtime.lastError) return setMsg(chrome.runtime.lastError.message, 'err');
    if (!res || !res.ok) return setMsg((res && res.error) || 'Run failed.', 'err');

    if (isPreview) {
      setMsg(
        res.matched
          ? res.wipeAll
            ? `Wipe-all is armed: all ${res.scanned} entries would be erased.`
            : state.settings.listMode === 'allow'
              ? `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} not on your keep list would be wiped.`
              : `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} would be wiped (scanned ${res.scanned}).`
          : `Nothing would be wiped after scanning ${res.scanned} entries.`,
        res.matched ? 'ok' : 'mini'
      );
      renderPreview(res.sample || []);
      return;
    }

    const extra = res.extra && res.extra.ok ? ` Extra data cleared too (${res.extra.kinds}).` : '';
    setMsg(
      (res.wipeAll
        ? `Erased ${res.deleted} entries, the entire history.`
        : `Scanned ${res.scanned}, wiped ${res.deleted}.`) + extra,
      res.deleted || extra ? 'ok' : 'mini'
    );
    if (res.deleted) renderPreview(res.sample || []);
    load();
  });
}

function renderPreview(sample) {
  const list = $('previewList');
  list.innerHTML = '';
  for (const item of sample.slice(0, 5)) {
    const div = document.createElement('div');
    div.className = 'logline';
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = item.url;
    const r = document.createElement('span');
    r.className = 'r';
    r.textContent = item.rule;
    div.append(u, r);
    list.appendChild(div);
  }
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

applyI18n();
load();
