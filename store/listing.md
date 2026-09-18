# Chrome Web Store listing copy

Ready to paste into the developer dashboard.

---

## 1. Short description (max 132 characters)

```
Remove chosen sites and words from your browsing history. Works while you browse, at browser close, or at the next start.
```

(123 characters.) This exact string lives in `_locales/en/messages.json` as `description`, which is
what `manifest.json` pulls through `__MSG_description__`. The `pl` locale carries the translated
version. The dashboard will not let you edit manifest metadata after upload, so a change means a
version bump and a fresh zip.

---

## 2. Detailed description

Keeps the sites and words you choose out of your browsing history.

Give it a list:

- a site, with or without its subdomains
- one page, or a folder on a site
- a word, like shoes. Titles count too, so "shoes - Google Search" goes as well
- a pattern, if you prefer regular expressions

Then pick when it runs: as you browse, when you close the browser, or at your next start. Preview
first if you want. Preview reads your history, reports what it would remove and which rule caught it,
and deletes nothing.

Prefer it the other way round? One checkbox turns the list into a keep list: the bank, your webmail
and the work wiki stay, everything else goes. Off by default, and it will not switch on while the
list is empty.

There is more than history here, all of it off until you pick it:

- Off: history only
- Light: cache
- Standard: cache, cookies and site data, saved form text
- Nuclear: all of that, plus download history and all of your history
- Custom: the four switches, your own mix

You choose how far back a clear reaches (an hour, a day, a week, a month, everything) and when it
runs (on the button, or also at browser close and start). Cookies have a keep list of their own plus
two triggers, at browser start and when you close a tab. Passwords are not offered at all, because
Chrome removed password deletion from extensions.

The popup stays small: state, one switch, wipe now, preview, and a line saying what else is being
cleared. Everything else is one click behind "More controls", and a header button brings back the
denser older layout. Six themes, light to neon, and an optional PIN lock that keeps the rule list off
the screen when someone else opens your settings.

No account, no server, and no network requests of its own. Your rules sit in the browser's synced
storage, which is how a rule added on one computer shows up on another; your history never leaves the
machine.

Two things to know before installing. Chrome shows a warning about reading and changing your browsing
history, and the wording cannot be narrowed. And Chrome gives extensions no way to notice the browser
shutting down, so close-mode does its work when the last window closes and, if that is missed, at the
next launch.

---

## 3. Privacy tab

### 3a. Single purpose description (max 1000 characters)

```
Deletes the browsing history entries a user chooses, and optionally clears the browser data the user explicitly switches on. The user lists sites, subdomains, keywords, URLs or patterns; the extension matches those against browsing history and erases the matching entries, either as the user browses, when the browser closes, or at the next start. Cache, cookies and site data, download history and saved form text are cleared only when the user picks a preset or turns a switch on and asks for it. It has no other function.
```

### 3b. Permission justifications (max 1000 characters each)

**history**

```
Required to read browsing history so the extension can find the entries matching the rules the user entered, and to delete only those entries. This is the extension's entire function. History is processed locally on the device, is never transmitted anywhere, and is not read for any other purpose.
```

**storage**

```
Keeps the user's rules, settings and an optional local log of wiped entries in browser storage. Settings and the log stay on the device. The rule list is stored in the browser's synced extension storage so it follows the user to their other signed-in devices; that transfer is performed by the browser's own sync, is never seen by the extension, and carries nothing but the rule list. Session storage holds the site of an open tab so a closed tab's cookies can be cleared; it is memory, cleared when the browser closes.
```

**notifications**

```
Displays an optional desktop notification after a wipe reporting how many entries were removed. The user can switch it off in the settings.
```

**contextMenus**

```
Adds two right-click menu items that let the user add the current page, or the site it belongs to, to their rule list without opening the options page.
```

**activeTab**

```
Used only after the user clicks the toolbar button. The popup reads the address of the current tab so it can offer to wipe that site or that page. Page content is not read.
```

**browsingData**

```
Used only by the optional clear presets (cache, cookies and site data, download history, saved form text). They are off by default; with them off the API is never called. When the user turns one on and presses the clear button, the extension calls chrome.browsingData.remove for the data types and time span the user selected. Nothing read from this API is stored or transmitted; the reply carries no data, so no count is shown. Passwords are not requested through this API.
```

**cookies**

```
Used for the cookie features the user switches on: clearing cookies at browser start or when a tab closes, and the keep list of sites whose cookies are never touched. The extension reads cookie names and domains to decide what to delete, and deletes only cookies that are not on the keep list. Cookie values are never read, stored or transmitted. With those features off (the default), no cookie is read or removed.
```

**tabs (optional, requested at runtime)**

```
Requested only when the user switches on "clear a site's cookies when I close its tab". Without it Chrome does not expose the address of a tab, so the extension could not tell which site a closed tab belonged to. The address is reduced to a host name, kept in session storage (memory, cleared when the browser closes) and deleted as soon as the tab closes. This permission is optional, so it never appears as an install warning.
```

### 3c. Remote code

Select **"No, I am not using remote code."** Leave the justification field empty.

### 3d. Data usage boxes

Tick **Web history / Online history** only. Leave the other eight unticked.

Google's User Data FAQ says "handle" covers collecting, transmitting, using or sharing, and it names
"collecting web browsing activity ... including the domains or URLs the browser interacts with". The
disclosure is required "even when data is processed or stored locally on a user's device and is not
transmitted to external servers or third parties". An extension holding `history` that declares
nothing is the inconsistency that gets a version rejected.

Unticked and correct: identification, health, financial and payment, authentication, personal
communications, location, user activity, website content.

Cookies and the other clear targets do not change those boxes. They are deleted locally at the user's
request; their contents are never read, kept or sent. The rule list travelling through the browser's
own sync is the user's browser feature, not a transfer by the extension, and rules are not browsing
history. The policy says the same thing, and the two must agree.

### 3e. Certifications

Tick all three. All are true: nothing is sold or transferred to third parties, nothing is used for
purposes unrelated to the single purpose, and nothing is used for creditworthiness or lending.

### 3f. Privacy policy URL

```
https://forsigh.github.io/lil-bro-history-wipe/privacy.html
```

Served by GitHub Pages from `docs/` on `main`. Edit the file, commit and push: Pages rebuilds in about
a minute. The hosted policy and the dashboard declarations must never drift apart.

The policy now covers the clear presets, the cookie keep list and the optional tab access. That has to
be true before this version goes up.

---

## 4. Before you submit

1. **Screenshots.** At least one, 1280x800 or 640x400. Replace the current ones: they show the old
   popup. Take the new set with the theme you want on display.
2. **Promo tile.** `store/promo-440x280.png` and `store/marquee-1400x560.png` are generated.
3. **128x128 icon.** In `icons/` and referenced by the manifest.
4. **Category.** Privacy & Security.
5. **Package.** `builds/lil-bro-history-wipe-1.3.2.zip`. manifest.json at the root, no comments,
   every referenced file present, locales included. Every upload needs a higher version.

## 5. What users see at install

Chrome attaches this warning to `history`, and the wording cannot be narrowed:

```
Read and change your browsing history on all your signed-in devices
```

The other permissions produce no warning of their own, `cookies` and `browsingData` included. `tabs`
is optional, so it is not part of the install prompt at all; Chrome asks for it the first time the
user switches on the tab-close cookie rule.

Shipping this over 1.2.0: Chrome disables an extension on update only when a new permission produces a
**new warning**. Nothing here does, so the update should land silently. That is a reading of Chrome's
documentation rather than a promise, so keep an eye on the install count afterwards. The listing text,
the screenshots and the hosted policy all have to describe the new behaviour before the upload.
