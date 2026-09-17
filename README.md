# Lil Bro - History Wipe

A Manifest V3 extension for Chrome and Brave. You tell it what to forget, and it takes those
entries out of the browser's history. Nothing is collected and nothing leaves the machine. The
extension makes no network requests at all.

## Install (unpacked, 30 seconds)

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the icon, then open **All rules & settings**.

Chrome warns at install that the extension can *"read and change your browsing history on all your
signed-in devices"*. That warning belongs to the `history` permission rather than to this code, and
Chrome does not let me word it any more narrowly. The extension reads your history for one reason:
matching it against the rules you wrote.

## When it wipes

| Mode | Behaviour |
| --- | --- |
| **Instantly, as I browse** | The entry is deleted the moment Chrome records it. It never shows up in history. |
| **When I close the browser** | Matches stay visible during the session, then are wiped. Chrome gives extensions no shutdown hook, so the wipe is attempted when the last window closes and guaranteed on the next launch. |
| **When I start the browser** | Matches are queued during the session and cleared at the start of the next one. |

**Also deep-scan existing history at browser start** (on by default) walks the whole history
database with a paginated scan, so entries that predate a rule get cleaned too.

## What it wipes

| Rule type | Matches |
| --- | --- |
| **Site / domain** | `example.com` matches `example.com` and `www.example.com`; tick *include all subdomains* to catch `shop.example.com` and `a.b.example.com` too. |
| **URL or URL prefix** | `https://example.com/private` matches that exact URL and anything under it (`/private/1`, `/private?x=1`), but not `/privateering`. |
| **Keyword in URL or title** | `shoes` hits `google.com/search?q=shoes` and `shoes - Google Search`, because matching covers the page title as well. *Whole words only* stops `shoes` from catching `shoesupply.com`. |
| **Regular expression** | Full control, e.g. `^https://translate\.google\.[^/]+/` to clear out Google Translate history. |

Rules are a plain list. Switch one off, delete it, or export the whole set to JSON and import it on
another machine.

Before you trust a rule, paste a URL (and a page title if you like) into **Test a URL against your
rules** on the options page. It tells you which rule would catch it, or that nothing would.

## Files

```
manifest.json      MV3 manifest. Permissions: history, storage, notifications, contextMenus, activeTab
matcher.js         pure matching engine (domains, subdomains, URL prefixes, keywords, regex)
store.js           state schema, defaults, rule validation
confirm-gate.js    the confirmation ordering, as pure functions
service-worker.js  the only component that deletes anything
options.html/js    rule list, timing modes, tester, log, import/export
popup.html/js      pause/resume, quick-add the current site, wipe now
styles.css         UI
icons/             16 / 32 / 48 / 128 px
tools/             icon generator
tests/             node test suites (see below)
```

## Checking that it works

1. Add one rule, something you do not mind losing from history.
2. Click **Preview only (no delete)**. It scans the whole database read-only, reports how many
   entries *would* be wiped, and lists the first matches with the rule that caught each one.
   Nothing is touched.
3. Happy with the count? Click **Wipe now**. It reports `Scanned N, wiped M` and lists what went.
   Open `chrome://history` to confirm they are gone.
4. For the automatic modes, browse to a matching site and check that the entry never appears
   (instant mode), or watch the queued counter, close the browser, reopen it, and see the entry gone.
5. To exercise the whole-history toggle: arm it. Arming asks first and erases nothing. The popup
   turns red and reads *"Armed: wiping ALL history"*, then you press the button and satisfy both
   gates: type `WIPE ALL`, then click the red confirm. Only after that does it report
   `Erased N entries, the entire history.`

The footer of the options page shows the version it is running, so you can tell which build your
browser is holding.

## Danger zone: wipe all history

One toggle at the bottom of the options page, `Wipe all history, not just my rules`, switches the
extension from rule-based to whole-database. It is off by default and sits behind a confirmation
dialog.

| Mode | With the toggle on |
| --- | --- |
| Instantly | Every new visit is erased as it happens. Existing history goes too, if the deep-scan box is ticked. |
| On close | The entire history is erased when the last window closes, and guaranteed at the next launch. |
| At start | The entire history is erased at every browser start. |

What it does not do: cookies, cache, passwords, downloads and site data are untouched, because the
extension never requests the `browsingData` permission. The wipe is `chrome.history.deleteAll()` and
nothing else. The test suite enforces that: the call has to appear exactly once, inside the wipe-all
function, and must never be reachable from the rule engine.

Preview stays read-only even when the toggle is on, and reports how many entries would go. Pausing
beats everything: while the extension is paused, the toggle erases nothing.

## Confirmations

Nothing destructive fires from a single click.

| Action | Gates |
| --- | --- |
| **Wipe ALL history now** (armed) | Two. Type `WIPE ALL` in the popup (a prompt dialog on the options page), then click the red confirm inside a five-second window. |
| **Wipe now** (rules) | Two clicks in the popup, or a confirmation dialog on the options page. |
| Arming the wipe-all toggle | A dialog spelling out what it does. Arming on its own erases nothing. |
| Remove a rule, clear the log, import rules | A confirmation each. |
| **Preview** | Never asks. It deletes nothing. |

If a confirmation times out or the phrase does not match, nothing is wiped and the state resets. The
gate logic is pure functions in `confirm-gate.js`, which is what makes the ordering testable: the
suite proves the final confirmation is **unreachable** unless the phrase matched first, that a
cancelled or mismatched phrase never reaches the last dialog, and that a truthy-but-not-`true`
answer is not treated as consent.

## Tests

No build step, no dependencies. Run:

```
npm test                      # or the four node commands below
node tests/matcher.test.mjs   # matching engine: 43 cases
node tests/gate.test.mjs      # confirmation gates and their wording: 31 cases
node tests/worker.test.mjs    # the worker against a fake chrome.* API and a fake history DB: 82 cases
node tests/pages.test.mjs     # element ids, manifest sanity, settings/rule-type consistency, deletion scope, gate wiring
```

The worker suite runs the real `service-worker.js`: instant deletion on visit, the deferred queue,
the last-window flush, full-database pagination (2 500 fake entries across several `history.search`
pages), the `startTime: 0` guard, the paused state, the notification and log switches, log caps, the
read-only preview, right-click rule creation, 20 simultaneous visits, and the whole wipe-all matrix
including "cookies and cache were never touched" and "off by default". The 20-visit case is worth
keeping: without the queue lock, 19 of those 20 entries are silently lost.

The suite I trust most is the blast-radius one. With two rules and 210 history entries it asserts
that exactly the 5 matching URLs were deleted, that every lookalike (`nottarget.example`,
`target.example.evil.io`, `example.com/target`) survived, and that no whole-history or
`browsingData` call happened at all.

## Known limits

1. No shutdown hook. Chrome terminates an extension's service worker after roughly 30 seconds idle
   and fires nothing on exit, so "when I close the browser" is attempted at close and *guaranteed at
   next launch*. There is no way around this in MV3.
2. Address-bar leftovers. Deleting a history entry does not always clear a previously typed address
   from the omnibox suggestion list. Chrome keeps typed shortcuts in a separate table with no
   extension API. The entry is gone from `chrome://history`; a stale omnibox hint can survive. No
   shipping extension has closed that gap.
3. Deletion scope. `history.deleteUrl` removes every visit to a URL, not just the matching visit, so
   a keyword rule deletes the whole page rather than one visit.
4. Sync. With history sync on, Chrome propagates the deletion to your other signed-in devices. A
   too-broad keyword rule travels with it. Use the tester.
5. Timing. A deep scan is budgeted to about four minutes per run to stay inside Chrome's per-request
   limit. A very large history finishes across successive runs.

## Permission notes

Only `history` produces an install warning. `storage` keeps your rules on the device, `notifications`
reports the wipe count, `contextMenus` powers the right-click item "Lil Bro: wipe this site", and
`activeTab` is what lets the popup read the current tab's URL when you click the toolbar icon. No
host permissions, no content scripts, no network access.
