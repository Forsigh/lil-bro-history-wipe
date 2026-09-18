# Lil Bro - History Wipe

A Manifest V3 extension for Chrome and Brave. Give it a list of sites and words, and it erases the
matching entries from your browsing history: as you browse, when you close the browser, or at your
next start. No account, no server, no network requests.

If you have browser sync on, the rule list itself travels between your computers through Chrome's
synced storage. Your history, the log and every switch stay on this device.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, pick this folder.
4. Pin the icon, then open **All rules & settings**.

Chrome warns that the extension can read and change your browsing history. That warning comes from the
`history` permission, and Chrome does not allow narrower wording. Nothing else here adds a warning.

## When it wipes

| Mode | What happens |
| --- | --- |
| **As I browse** | Each entry is deleted the moment Chrome records it. Heaviest of the three. |
| **When the browser closes** | Matches stay for the session, then go. Chrome gives no shutdown hook, so it runs at close when it can and at the next start otherwise. |
| **At browser start** | Matches are queued during the session and cleared at the next start. |

**Deep-scan** (on by default) walks the existing history database too, so entries older than a rule
get cleaned as well.

## Rules

| Type | Matches |
| --- | --- |
| **Site** | `example.com` covers `example.com` and `www.example.com`. Tick *subdomains too* for `shop.example.com`. |
| **URL or prefix** | `https://example.com/private` covers that URL and anything under it, not `/privateering`. |
| **Keyword** | `shoes` hits `google.com/search?q=shoes` and `shoes - Google Search`, title included. *Whole words* stops `shoesupply.com`. |
| **Regular expression** | Capped at 200 characters. Nested repeats like `(a+)+` are refused. |

Export the list to JSON, import it elsewhere, switch a rule off or delete it. The tester on the
options page tells you which rule would catch a URL before you trust it.

There is also a **keep list**: tick `Keep only the sites I list` and a page is wiped when it is *not*
on your list. Off by default, and it refuses to switch on with an empty list.

## Clearing: pick a preset

The history wipe is separate and always on. Next to it, pick how much else goes:

| Preset | What it clears |
| --- | --- |
| **Off** | History only. |
| **Light** | Cache. |
| **Standard** | Cache, cookies and site data, saved form text. |
| **Nuclear** | All of the above plus download history, and all of your history. |
| **Custom** | The four switches, your own mix. |

Two more choices: how far back (an hour, a day, a week, a month, everything) and when (only on the
button, or also at browser close and start). A clear also rides along with `Wipe now`.

Worth knowing: Chrome reports nothing back, so there is no count. Cookies go for the whole site, so
logins there end. Download history is the list, not the files. History, download and form text cannot
be narrowed to one site. Passwords are not offered at all: Chrome removed password deletion from the
extension API in 144.

## Cookies

Two triggers of their own, both off by default:

- **Clear cookies at browser start**, keeping the sites in the keep list.
- **Clear a site's cookies when I close its tab.** This needs tab access, which Chrome asks for only
  when you switch it on. It is an optional permission, so it never appears at install.

The keep list is one domain per line. Those sites are never touched. `Clear cookies now` does a pass
on demand.

## PIN lock

`Ask for a PIN before showing or editing my list` hides the rules, the tester, the log, the backup and
the danger zone until the PIN is entered, and the popup drops the preview and add buttons. The lock
takes hold the moment the PIN is saved, and `Hide the list now` puts it back without a reload. The
right-click item that adds a site only sends a notification while the lock is on.

The PIN is salted, stretched with PBKDF2-SHA256 150 000 times, and stored locally only. Five wrong
tries park the pad for 30 seconds. Forgot it? `Forgot the PIN?`, type `lilbro`, and the PIN goes,
along with the list and everything else the extension saved. It keeps the list off the screen and
encrypts nothing; anyone who can open `chrome://extensions` can still remove the extension.

## Popup

Compact by default: state, on/off switch, `Wipe now`, `Preview`, and a line saying what else is being
cleared. Everything else sits behind `More controls`. The header button switches to the classic
denser layout and remembers the choice.

## Themes

Six: Auto (follows your system), Dark, Light, Neon, Paper, Slate. Pick one on the options page; both
pages and the popup follow it.

## Tests

No build step, no dependencies.

```
npm test
node tests/matcher.test.mjs   # matching engine and the regex guards: 68 cases
node tests/gate.test.mjs      # confirmation gates and their wording: 31 cases
node tests/lock.test.mjs      # PIN lock, hashing, throttle, recovery: 38 cases
node tests/worker.test.mjs    # the worker against a fake chrome.* and history DB: 166 cases
node tests/pages.test.mjs     # ids, manifest, settings and rule-type consistency, deletion scope
```

The worker suite runs the real `service-worker.js`: instant deletion, the deferred queue, the
last-window flush, pagination over a large fake history, the keep-list matrix, rule sync including
the 8 KB chunking, the wipe-all matrix, the extra clear, and the cookie paths (keep list, start
trigger, tab close, and a build with no permission at all).

```
node tools/live_probe.mjs     # 78 checks in a real browser
node tools/packager.mjs       # build the zip
```

The probe stages a copy of this folder in a throwaway profile and drives the real extension against a
real history database: the manifest the browser loaded, the permission surface, exact-match deletion,
keep mode, the armed wipe-all with both gates, the extra clear against the real browsing-data API, the
cookie keep list, the three themes and presets as rendered, both popup layouts, and the PIN lock.
It never touches your own profile.

## Limits

- No shutdown hook exists in MV3, so close-mode runs at close when it can and at the next start
  otherwise.
- A deleted entry can still appear in address-bar suggestions. That store has no extension API.
- `history.deleteUrl` removes every visit to a URL, not just the matching one.
- With history sync on, a deletion propagates to your other devices, and a too-broad rule travels.
- A deep scan is budgeted to about four minutes per run; a huge history finishes over several runs.
- Cookie and cache clearing can be per site. History, downloads and form text cannot.
- No password clearing, ever.

## Permissions

`history` (the only one that warns), `storage` (rules sync, switches local), `notifications`,
`contextMenus`, `activeTab` (the popup reads the current tab's URL), `browsingData` (the clearing
presets), `cookies` (the keep list and cookie triggers, no warning of its own). `tabs` is optional and
asked for only by the tab-close feature. No host permissions, no content scripts, no network access.
