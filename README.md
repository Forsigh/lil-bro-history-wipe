# Lil Bro — History Wipe

A Manifest V3 extension for Chrome and Brave. You tell it what to forget; it takes
those entries out of the browser's history. Nothing is collected and nothing leaves
the machine — the extension makes no network requests at all.

## Install (unpacked, 30 seconds)

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the icon, then open **All rules & settings**.

Chrome will warn at install time that the extension can *"read and change your
browsing history on all your signed-in devices"* — that warning is attached to the
`history` permission by Chrome itself and cannot be narrowed. The extension never
reads history for anything other than matching your own rules.

## When it wipes

| Mode | Behaviour |
| --- | --- |
| **Instantly, as I browse** | The entry is deleted the moment Chrome records it. It never shows up in history. |
| **When I close the browser** | Matches stay visible during the session, then are wiped. Chrome gives extensions **no shutdown hook**, so the wipe is attempted when the last window closes and guaranteed on the next launch. |
| **When I start the browser** | Matches are queued during the session and cleared at the start of the next one. |

**Also deep-scan existing history at browser start** (on by default) runs a full
paginated scan of the whole history database, so entries that were already there
before a rule existed get cleaned too.

## What it wipes

| Rule type | Matches |
| --- | --- |
| **Site / domain** | `example.com` — matches `example.com` and `www.example.com`; tick *include all subdomains* to also catch `shop.example.com`, `a.b.example.com`. |
| **URL or URL prefix** | `https://example.com/private` — matches that exact URL and anything beneath it (`/private/1`, `/private?x=1`), but not `/privateering`. |
| **Keyword in URL or title** | `shoes` — hits `google.com/search?q=shoes` **and** `shoes - Google Search`, because matching covers the page title too. *Whole words only* prevents `shoes` from matching `shoesupply.com`. |
| **Regular expression** | Full control, e.g. `^https://translate\.google\.[^/]+/` to kill Google-Translate history spam. |

Rules are plain lists: enable/disable each one, remove it, or export/import the whole
set as JSON to move between machines.

**Test a URL against your rules** before trusting them — paste a URL (and optionally a
page title) and the options page tells you which rule would wipe it, or that nothing
would.

## Files

```
manifest.json      MV3 manifest — permissions: history, storage, notifications, contextMenus, activeTab
matcher.js         pure matching engine (domains, subdomains, URL prefixes, keywords, regex)
store.js           state schema, defaults, rule validation
service-worker.js  the only component that deletes anything
options.html/js    rule list, timing modes, tester, log, import/export
popup.html/js      pause/resume, quick-add current site, wipe-now
styles.css         UI
icons/             16 / 32 / 48 / 128 px
tools/             icon generator
tests/             node test suites (see below)
```

## Checking that it works

1. Add one rule (e.g. a site you do not mind losing from history).
2. Click **Preview only (no delete)** in the popup or the options page. It scans the
   whole database read-only and tells you exactly how many entries *would* be wiped,
   plus the first matches and which rule caught them. Nothing is touched.
3. Happy with the result? Click **Wipe now**. It reports `Scanned N, wiped M` and lists
   what went. Open `chrome://history` to confirm they are gone.
4. For the automatic modes, browse to a matching site and check the entry never
   appears (instant mode), or watch the *queued* counter, close the browser, reopen it,
   and see the entry gone.
5. To check the whole-history toggle: arm it (it asks first — nothing is erased by
   arming), watch the popup turn red and read *"Armed — wiping ALL history"*, then
   press the button and satisfy **both** gates: type `WIPE ALL`, then click the red
   confirm. Only then does it report `Erased N entries — the entire history.` The
   options page footer shows which build you are running (`v1.0.3`).

The options page footer shows the loaded version, so you can tell at a glance which
build the browser is running.

## Danger zone: wipe all history

A single toggle at the bottom of the options page (`Wipe all history, not just my rules`, **off by default,
behind a confirmation dialog**) switches the extension from rule-based to whole-database:

| Mode | With the toggle on |
| --- | --- |
| Instantly | Every new visit is erased as it happens. Existing history is also cleared if the deep-scan box is ticked. |
| On close | The entire history is erased when the last window closes (and guaranteed at next launch). |
| At start | The entire history is erased at every browser start. |

What it does **not** do: cookies, cache, passwords, downloads and site data are untouched, because the
extension never requests the `browsingData` permission. The wipe is `chrome.history.deleteAll()` and nothing
else — and the test suite enforces that: the call must appear exactly once, inside the wipe-all function, and
must never be reachable from the rule engine.

Preview stays read-only even when armed, reporting how many entries would go. Pausing wins over everything:
with the extension paused, the toggle erases nothing.

## Confirmations

Nothing destructive fires on a single click:

| Action | Gates |
| --- | --- |
| **Wipe ALL history now** (armed) | **Two**: type `WIPE ALL` in the popup (or the prompt dialog on the options page), then click the red confirm button inside a 5-second window. |
| **Wipe now** (rules) | **Two clicks** in the popup, or a confirmation dialog on the options page. |
| Arming the wipe-all toggle | A dialog spelling out exactly what it will do; arming alone erases nothing. |
| Remove a rule / Clear the log / Import rules | A confirmation each. |
| **Preview** | Never asks — it deletes nothing. |

If a confirmation times out or the phrase does not match, nothing is wiped and the
state resets. The gate logic lives in `confirm-gate.js` as pure functions so the
ordering is testable: the suite proves the final confirmation is **unreachable**
unless the phrase matched first, that a cancelled or mismatched phrase never reaches
the last dialog, and that a truthy-but-not-`true` answer is not treated as consent.

## Tests

No build step, no dependencies. Run:

```
npm run test                  # or the four node commands below
node tests/matcher.test.mjs   # matching engine: 43 cases
node tests/gate.test.mjs      # confirmation gates and their wording: 31 cases
node tests/worker.test.mjs    # the worker against a fake chrome.* API and fake history DB: 82 cases
node tests/pages.test.mjs     # element ids, manifest sanity, settings/rule-type consistency, deletion scope, gate wiring
```

The worker suite exercises the real `service-worker.js`: instant deletion on visit, the deferred queue, the
last-window flush, full-database pagination (2 500 fake entries across multiple `history.search` pages), the
`startTime: 0` guard, the paused state, notification and log switches, log caps, the read-only preview,
right-click rule creation, 20 simultaneous visits (which the queue serialises — without that lock, 19 of the
20 entries are silently lost), and the whole wipe-all matrix above including "cookies and cache were never
touched" and "off by default".

The blast-radius suite is the important one: with two rules and 210 history entries it asserts that exactly
the 5 matching URLs were deleted, that every lookalike (`nottarget.example`, `target.example.evil.io`,
`example.com/target`) survived, and that no whole-history or `browsingData` call was made at all.

## Known limits (honest list)

1. **No shutdown hook.** Chrome terminates an extension's service worker after ~30 s
   idle and fires nothing on exit. "When I close the browser" is therefore attempted
   at close and *guaranteed at next launch*. There is no way around this in MV3.
2. **Address-bar leftovers.** Deleting a history entry does not always clear a
   previously *typed* address from the omnibox suggestion list — Chrome stores typed
   shortcuts in a separate table with no extension API. The entry is gone from
   `chrome://history`; a stale omnibox hint can survive. This is the one gap no
   shipping extension has closed.
3. **Deletion scope.** `history.deleteUrl` removes every visit to a URL, not just the
   matching visit. Keyword rules therefore delete the whole page, not the visit.
4. **Sync.** If history sync is on, Chrome propagates the deletion to your other
   signed-in devices. A too-broad keyword rule spreads with it — use the tester.
5. **Timing.** A deep scan is budgeted to ~4 minutes per run to stay inside Chrome's
   per-request limit; a very large history finishes across successive runs.

## Permission notes

Only `history` produces an install warning. `storage` keeps rules locally,
`notifications` reports the wipe count, `contextMenus` powers right-click
"Lil Bro: wipe this site", and `activeTab` is what lets the popup read the current
tab's URL when you click the toolbar icon. No host permissions, no content scripts,
no network access.
