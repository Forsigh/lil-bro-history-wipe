// Lil Bro: toolbar popup
//
// What it shows: the state, the switch, whether the tab in front of you is one of
// the ones that gets cleaned, the two runs, and the lock card when there is one.

import {
  getState,
  saveState,
  buildRule,
  describeRule,
  normalizeDomain,
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
import { isLockConfigured } from './lock.js';
import { findMatch, isWipeableUrl } from './matcher.js';
import { whyLine, headline, hostLabel } from './logtext.js';
import { applyI18n, setLang, t, currentLang } from './i18n.js';

const $ = (id) => document.getElementById(id);

let state = null;
let currentUrl = '';
let currentTitle = '';
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
  await setLang(state.settings.lang);
  // After the language, not before: the labels come from the bundle.
  applyI18n();
  render();
  applyLock();
  await loadCurrentTab();
  $('version').textContent = 'Lil Bro v' + chrome.runtime.getManifest().version;
}

/**
 * A PIN is set. The popup is a small control surface, so it keeps working: the switch,
 * the two runs and adding the site in front of you all stay. What it does not do is
 * name anything on the list, and it does not ask for the PIN, because there is nothing
 * here worth a lock screen and a box that only disappears once you type in it is a
 * worse answer than plain hiding.
 */
function isLocked() {
  return isLockConfigured(state.settings);
}

/** Take the parts that would name the list off the screen, and say where to unlock. */
function applyLock() {
  const locked = isLocked();
  document.body.classList.toggle('locked', locked);
  $('lockCard').classList.toggle('hidden', !locked);
  if (!locked) return;
  $('lockNote').textContent =
    t('lockPopupNote') || 'The list stays hidden while the PIN is on. Unlock it in the settings.';
  $('previewList').innerHTML = '';
  // A scan here only ever produced that list, so it would do nothing visible.
  $('previewBtn').disabled = true;
  $('wipeMsg').textContent = '';
  $('siteVerdict').textContent = '';
}

/** Numbers the way the page's language writes them: Polish groups with a space. */
function formatCount(n) {
  try {
    return new Intl.NumberFormat(currentLang()).format(n);
  } catch {
    return String(n);
  }
}

/** The count with the word the language wants, since Polish has three forms. */
function countWords(count) {
  let key = 'entryMany';
  try {
    const picked = new Intl.PluralRules(currentLang()).select(count);
    if (picked === 'one') key = 'entryOne';
    else if (picked === 'few') key = 'entryFew';
  } catch {
    // A browser without the locale data still has to say something true.
  }
  return t(key, [String(count)]);
}

/** What each rule has caught, busiest first. Nothing is counted until a wipe happens,
 *  so an empty list is the honest state for a fresh install, not a broken one. */
function renderTopRules() {
  const box = $('topRules');
  if (!box) return;
  box.textContent = '';
  const byRule = (state.stats && state.stats.byRule) || {};
  const rows = (state.rules || [])
    .map((rule) => ({ rule, count: byRule[rule.id] || 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  if (!rows.length) {
    const line = document.createElement('div');
    line.className = 'row mini';
    line.textContent = t('caughtNone');
    box.appendChild(line);
    return;
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'row mini';
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = describeRule(row.rule);
    const count = document.createElement('span');
    count.textContent = countWords(row.count);
    line.append(name, count);
    box.appendChild(line);
  }
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
  $('keptOut').textContent = formatCount(state.stats.wipedTotal || 0);
  renderTopRules();
  $('statTotal').textContent = state.stats.wipedTotal || 0;
  $('statLast').textContent = state.stats.lastRunCount || 0;
  $('subdomains').checked = !!state.settings.includeSubdomainsDefault;

  // The extra clear, when it is switched on anywhere.
  const extras = extraOn(s);
  $('extraRow').classList.toggle('hidden', !extras);
  if (extras) {
    $('extraBtn').textContent = t('clearNow') || 'Clear now';
    $('extraLine').textContent =
      t('popAlsoClearing', [describeExtras(s), EXTRA_SINCE_LABELS[s.extraSince] || s.extraSince]) ||
      `Also clearing: ${describeExtras(s)}, ${EXTRA_SINCE_LABELS[s.extraSince] || s.extraSince}.`;
  } else {
    $('extraLine').textContent = t('popHistoryOnly') || 'History only.';
  }

  document.documentElement.dataset.theme = s.theme || 'auto';

  const queued = (state.pending || []).length;
  $('queueInfo').textContent =
    s.mode === 'realtime'
      ? ''
      : t(s.mode === 'onclose' ? 'popQueueClose' : 'popQueueStart', [queued]) ||
        `${queued} ${queued === 1 ? 'entry' : 'entries'} queued, wiped ${
          s.mode === 'onclose' ? 'when you close the browser' : 'at your next start'
        }.`;

  updateVerdict();
}

async function loadCurrentTab() {
  // Even with the PIN on, the site in front of you is worth naming: it is on screen
  // anyway, and adding it is the one thing this popup is for that protects you.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl = (tab && tab.url) || '';
    currentTitle = (tab && tab.title) || '';
  } catch {
    currentUrl = '';
    currentTitle = '';
  }
  const domain = normalizeDomain(currentUrl);
  const usable = /^https?:/i.test(currentUrl) && domain;
  $('sitePreview').textContent = usable
    ? `${t('siteCurrentTab') || 'Current tab'}: ${domain}`
    : t('siteNoSite') || 'This tab has no wipeable site.';
  $('addDomainBtn').disabled = !usable;
  $('addUrlBtn').disabled = !usable;
  updateVerdict();
}

/**
 * The line this whole screen exists for: is the tab in front of you one of the
 * ones about to be cleaned? It asks the same matcher the worker asks, with the
 * same rules, so the answer cannot drift from what really happens. In keep mode
 * the answer inverts: the page that goes is the one that is not on your list.
 * While the lock is on it says nothing, like everything else here.
 */
function updateVerdict() {
  const el = $('siteVerdict');
  if (isLocked()) {
    el.textContent = '';
    el.className = 'row verdict';
    return;
  }
  const s = state.settings;
  const keepMode = s.listMode === 'allow';
  const usable = isWipeableUrl(currentUrl);
  if (!usable) {
    // The line above already says this tab cannot be wiped. Saying it twice, in
    // two voices, was the first thing anyone noticed about this screen.
    el.textContent = '';
    el.className = 'row verdict';
    return;
  }
  const hit = findMatch({ url: currentUrl, title: currentTitle }, state.rules);
  const goes = keepMode ? !hit : !!hit;

  let key = keepMode ? 'siteKept' : 'siteNotListed';
  let kind = 'ok';
  if (!s.enabled) {
    key = 'sitePaused';
    kind = 'warn';
  } else if (s.wipeAllHistory) {
    key = 'siteAll';
    kind = 'danger';
  } else if (goes) {
    key = s.mode === 'realtime' ? 'siteCleanedNow' : 'siteCleanedStart';
    kind = 'danger';
  }

  el.textContent = t(key) || '';
  el.className = 'row verdict ' + kind;
}

function addRule(rule) {
  state.rules.push(rule);
  saveState({ rules: state.rules }).then(() => {
    setMsg(
      // With the lock on, the site name stays out of this page, so the note says
      // what happened and nothing more.
      isLocked()
        ? (state.settings.listMode === 'allow' ? t('keptOnly') || 'Kept.' : t('addedOnly') || 'Added.')
        : state.settings.listMode === 'allow'
          ? t('popKeptRule', [describeRule(rule)]) || `Keeping ${describeRule(rule)}.`
          : t('popAddedRule', [describeRule(rule)]) || `Added ${describeRule(rule)}.`,
      'ok'
    );
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
  setMsg(t('msgClearing') || 'Clearing…');
  chrome.runtime.sendMessage({ type: 'clearExtra' }, (res) => {
    if (chrome.runtime.lastError) return setMsg(chrome.runtime.lastError.message, 'err');
    if (!res || !res.ok) return setMsg((res && res.error) || t('errClearFailed') || 'The clear failed.', 'err');
    setMsg(
      t('resClearedNoCount', [res.kinds, EXTRA_SINCE_LABELS[res.since] || res.since]) ||
        `Cleared ${res.kinds} (${EXTRA_SINCE_LABELS[res.since] || res.since}). Chrome gives no count.`,
      'ok'
    );
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
  $('wipeBtn').textContent = state.settings.wipeAllHistory
    ? t('wipeAllNow') || 'Wipe ALL history now'
    : t('wipeNow') || 'Wipe now';
  setMsg(message || '');
}

$('confirmPhraseBtn').addEventListener('click', () => {
  if (!checkPhrase($('confirmPhrase').value)) {
    setMsg(
      t('errPhraseMismatch', [WIPE_ALL_PHRASE]) ||
        `That is not the phrase, so nothing was armed. It must read exactly: ${WIPE_ALL_PHRASE}`,
      'err'
    );
    return;
  }
  phraseOk = true;
  armAt = Date.now();
  $('phraseRow').classList.add('hidden');
  $('confirmPhrase').value = '';
  $('wipeBtn').textContent = MESSAGES.wipeAllStep2;
  setMsg(MESSAGES.wipeAllArmed, 'warn');
  armResetLater();
  // The row just closed under the keyboard, and the next click is the wipe, so the
  // focus goes there rather than landing on a hidden element and being dropped.
  $('wipeBtn').focus();
});

// Escape leaves an open confirmation the way every other dialog does: the row goes,
// nothing is armed, and the keyboard goes back to the button that opened it.
$('confirmPhrase').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  resetArm();
  $('wipeBtn').focus();
});

function runAction(type) {
  const isPreview = type === 'preview';
  setMsg(isPreview ? t('msgLooking') || 'Looking for matches…' : t('msgWiping') || 'Wiping…');
  $('previewList').innerHTML = '';
  chrome.runtime.sendMessage({ type }, (res) => {
    if (chrome.runtime.lastError) return setMsg(chrome.runtime.lastError.message, 'err');
    if (!res || !res.ok) return setMsg((res && res.error) || t('errRunFailed') || 'Run failed.', 'err');

    if (isPreview) {
      setMsg(
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
      renderPreview(res.sample || []);
      return;
    }

    const extra = res.extra && res.extra.ok ? t('resExtraCleared', [res.extra.kinds]) || ` Extra data cleared too (${res.extra.kinds}).` : '';
    setMsg(
      (res.wipeAll
        ? t('resErasedAll', [res.deleted]) || `Erased ${res.deleted} entries, the entire history.`
        : t('resScannedWiped', [res.scanned, res.deleted]) || `Scanned ${res.scanned}, wiped ${res.deleted}.`) +
        extra,
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
    const head = document.createElement('span');
    head.className = 'h';
    head.textContent = headline(item);
    const why = document.createElement('span');
    why.className = 'w';
    why.textContent = whyLine(t, item);
    const meta = document.createElement('span');
    meta.className = 'm';
    const host = document.createElement('span');
    host.className = 'a';
    host.textContent = hostLabel(item.url);
    meta.append(host);
    div.append(head, why, meta);
    list.appendChild(div);
  }
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/**
 * Anything that throws on the way up leaves this popup sitting on "Loading…" for good,
 * which tells the person nothing and looks like the extension is dead. Say what happened
 * instead, keep the version on screen so a report of it means something, and put the
 * detail where it can be read.
 */
function fail(err) {
  const status = $('status');
  if (status) status.textContent = t('startFailed') || 'Could not start';
  const dot = $('dot');
  if (dot) dot.className = 'dot danger';
  setMsg(t('startFailedHint') || 'Reload the extension on the extensions page.', 'err');
  try {
    $('version').textContent = 'Lil Bro v' + chrome.runtime.getManifest().version;
  } catch {
    // there is nothing to write the version into, and the message above is the point
  }
  console.error('[Lil Bro] the popup could not start:', err);
}

load().catch(fail);
