// Lil Bro — options page

import {
  getState,
  saveState,
  mergeSettings,
  buildRule,
  describeRule,
  activeRules,
  RULE_TYPES,
} from './store.js';
import { findMatch } from './matcher.js';
import {
  doubleConfirm,
  singleConfirm,
  MESSAGES,
  WIPE_ALL_PHRASE,
} from './confirm-gate.js';

const $ = (id) => document.getElementById(id);

let state = null;

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
  renderRules();
  renderStats();
  renderLog();
  runTest();
  $('version').textContent =
    'Lil Bro v' + chrome.runtime.getManifest().version + ' — rules and settings are stored on this device only.';
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
  $('wipeNowBtn').textContent = s.wipeAllHistory ? 'Wipe ALL history now' : 'Wipe now';
  $('wipeAllWarn').textContent = s.wipeAllHistory
    ? 'ARMED — the entire history is erased on every trigger above, and "Wipe now" empties it immediately.'
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
      ? 'ARMED — wiping ALL history'
      : 'Paused'
    : enabled
      ? `Active — ${modeText}`
      : 'Paused';
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
      : `${queued} ${queued === 1 ? 'entry' : 'entries'} queued — wiped ${
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
  if (!live.length) {
    setMsg($('testOut'), 'No active rules — nothing would be wiped.', 'warn');
    return;
  }
  const rule = findMatch({ url, title }, live);
  if (rule) {
    setMsg($('testOut'), `Would be wiped by: ${RULE_TYPES[rule.type]} → ${describeRule(rule)}`, 'ok');
  } else {
    setMsg($('testOut'), 'No rule matches this — it stays in history.', 'mini');
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

$('ruleType').addEventListener('change', syncRuleTypeUi);

$('wipeAll').addEventListener('change', async () => {
  const wantsOn = $('wipeAll').checked;
  if (wantsOn) {
    const ok = window.confirm(
      'Arm the whole-history wipe?\n\n' +
        'Every trigger will then erase your entire browsing history instead of only matching your rules. ' +
        'Each wipe still has to be confirmed twice on its own, and arming this does not erase anything by itself.\n\n' +
        'Cookies, cache, passwords and site data are not touched.'
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
          ? `The phrase did not match — nothing was wiped. It must read exactly: ${WIPE_ALL_PHRASE}`
          : 'Cancelled — nothing was wiped.',
        'warn'
      );
    }
    return gate.ok;
  }

  const gate = await singleConfirm(() => window.confirm(MESSAGES.wipeNowConfirm));
  if (!gate.ok) setMsg($('sweepMsg'), 'Cancelled — nothing was wiped.');
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
            ? `Wipe-all is armed — all ${res.scanned} entries would be erased.`
            : `${res.matched} ${res.matched === 1 ? 'entry' : 'entries'} would be wiped (scanned ${res.scanned}).`
          : `Nothing would be wiped — scanned ${res.scanned} entries.`,
        res.matched ? 'ok' : 'mini'
      );
    } else if (res.wipeAll) {
      setMsg($('sweepMsg'), `Erased ${res.deleted} entries — the entire history.`, 'ok');
    } else {
      setMsg($('sweepMsg'), `Scanned ${res.scanned}, wiped ${res.deleted}.`, res.deleted ? 'ok' : 'mini');
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
      setMsg($('importMsg'), 'Import cancelled — no rules were added.');
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
    renderRules();
    runTest();
  } catch (err) {
    setMsg($('importMsg'), `Import failed: ${err.message}`, 'err');
  }
  e.target.value = '';
});

syncRuleTypeUi();
load();
