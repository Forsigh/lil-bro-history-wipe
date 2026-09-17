// Lil Bro — toolbar popup

import { getState, saveState, buildRule, describeRule, normalizeDomain } from './store.js';
import {
  checkPhrase,
  secondClickWithin,
  MESSAGES,
  WIPE_ALL_PHRASE,
  ARM_WINDOW_MS,
} from './confirm-gate.js';

const $ = (id) => document.getElementById(id);

let state = null;
let currentUrl = '';
let armAt = null;
let phraseOk = false;
let armTimer = null;

function setMsg(text, kind = 'mini') {
  const el = $('wipeMsg');
  el.textContent = text || '';
  el.className = 'row ' + kind;
}

async function load() {
  state = await getState();
  render();
  await loadCurrentTab();
  $('version').textContent = 'Lil Bro v' + chrome.runtime.getManifest().version;
}

function render() {
  const s = state.settings;
  const armed = !!s.wipeAllHistory;
  $('dot').className = 'dot' + (s.enabled ? '' : ' off') + (armed ? ' danger' : '');
  $('status').textContent = !s.enabled
    ? 'Paused'
    : armed
      ? 'Armed — wiping ALL history'
      : 'Active';
  $('toggleBtn').textContent = s.enabled ? 'Pause' : 'Resume';
  $('wipeBtn').textContent = armed ? 'Wipe ALL history now' : 'Wipe now';
  $('wipeAllWarn').textContent = armed
    ? 'Wipe-all is ON — the entire history goes, not just your rules. Cookies and cache are never touched.'
    : '';
  const modes = {
    realtime: armed ? 'Every visit is erased the moment it happens.' : 'Wiping instantly, as you browse.',
    onclose: armed ? 'Everything goes when you close the browser.' : 'Matches go when you close the browser.',
    startup: armed ? 'Everything goes at the start of your next session.' : 'Matches go at the start of your next session.',
  };
  $('modeText').textContent = modes[s.mode] || '';
  $('statTotal').textContent = state.stats.wipedTotal || 0;
  $('statLast').textContent = state.stats.lastRunCount || 0;
  $('subdomains').checked = !!state.settings.includeSubdomainsDefault;

  const queued = (state.pending || []).length;
  $('queueInfo').textContent =
    s.mode === 'realtime'
      ? ''
      : `${queued} ${queued === 1 ? 'entry' : 'entries'} queued — wiped ${
          s.mode === 'onclose' ? 'when you close the browser' : 'at your next start'
        }.`;
}

async function loadCurrentTab() {
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
    setMsg(`Added ${describeRule(rule)}.`, 'ok');
  });
}

$('toggleBtn').addEventListener('click', async () => {
  state.settings.enabled = !state.settings.enabled;
  await saveState({ settings: state.settings });
  render();
});

$('subdomains').addEventListener('change', async () => {
  state.settings.includeSubdomainsDefault = $('subdomains').checked;
  await saveState({ settings: state.settings });
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
    setMsg(`That is not the phrase — nothing was armed. It must read exactly: ${WIPE_ALL_PHRASE}`, 'err');
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
            ? `Wipe-all is armed — all ${res.scanned} entries would be erased.`
            : `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} would be wiped (scanned ${res.scanned}).`
          : `Nothing would be wiped — scanned ${res.scanned} entries.`,
        res.matched ? 'ok' : 'mini'
      );
      renderPreview(res.sample || []);
      return;
    }

    setMsg(
      res.wipeAll
        ? `Erased ${res.deleted} entries — the entire history.`
        : `Scanned ${res.scanned}, wiped ${res.deleted}.`,
      res.deleted ? 'ok' : 'mini'
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

load();
