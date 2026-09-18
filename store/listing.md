# Chrome Web Store listing copy

Everything in this file is ready to paste into the developer dashboard. Written to be
copied as-is: no stray punctuation, no marketing voice, nothing the reviewer has to
interpret.

---

## 1. Short description (manifest `description`, max 132 characters)

**Use this one** (124 characters):

```
Remove chosen sites and words from your browsing history. Works as you browse, when you close the browser, or at next start.
```

Alternates if you want a different tone:

```
Pick the sites and words you do not want in your history. Clears them as you browse, when you close the browser, or at next start.
```
(130 characters)

```
Choose sites and keywords. Lil Bro keeps them out of your browsing history: as you browse, on close, or at next start.
```
(118 characters)

Note: this exact string has to be in `manifest.json` as well. The dashboard will not let
you edit manifest metadata after upload, so if you change your mind you must bump the
version, re-zip and upload again.

---

## 2. Detailed description (paste into "Description" on the store listing)

Keeps the sites and words you choose out of your browsing history.

Give it a list:

- a site, with or without its subdomains
- one page, or a folder on a site
- a word, like shoes. That also matches page titles, so "shoes - Google Search" goes too
- a pattern, if you prefer regular expressions

Then pick when it runs. Instantly, as you browse. When you close the browser. Or at the
start of your next session.

Preview first if you want. Preview reads your history, tells you how many entries it
would remove and which rule caught each one, and deletes nothing. When you do press
Wipe now it tells you what it removed, and the wipe everything option makes you confirm
twice before it touches anything.

Prefer it the other way round? One checkbox turns the list into a keep list: the bank,
your webmail and the work wiki stay, everything else goes. Off by default, and it will
not switch on while the list is empty.

Two ways to run it from the popup, whichever suits you: only your list, or everything,
always. The everything switch is red, and both it and the wipe button ask before they
touch anything. The popup itself stays small: state, one switch, wipe now, preview, and a
line saying what is being wiped. Everything else is one click behind "More controls", and
a button in the header brings back the older layout with all of it on screen.

The list itself can be locked behind a PIN, so it is not sitting in plain sight when
someone else opens the settings page. Only a salted hash of the PIN is kept, and it stays
on the device. Forget the PIN and you are not stuck: type lilbro and the PIN comes off,
along with everything the extension had saved.

Four extra switches, all off until you turn them on: cache, cookies and site data,
download history and saved form text. Each one is a deliberate press, with a time span you
pick (last hour, day, week, month, or everything), and they run when you press the button
or, if you ask for it, when the browser closes or starts. Turn them on and you also get a
single button that clears them on their own without touching your history. Worth knowing
before you switch cookies on: they go for the whole registrable domain, so you end up
signed out of those sites. Passwords are not on the offer at all, because Chrome removed
password deletion from extensions.

No account and no server, and the extension makes no network requests of its own. Your
rules are kept in the browser's synced storage, which is how a rule added on one computer
shows up on your other ones; your history itself never leaves the machine.

Two things worth knowing before you install. Chrome only hands over browsing history
after you accept a warning about reading and changing it, and that warning cannot be
narrowed. And Chrome gives extensions no way to notice that the browser is shutting
down, so wiping on close does its work when the last window closes and, if that gets
missed, at the next launch.

---

## 3. Privacy tab

### 3a. Single purpose description (max 1000 characters)

```
Deletes the browsing history entries a user chooses, and optionally clears the browser data types the user explicitly switches on. The user lists sites, subdomains, keywords, URLs or patterns; the extension matches those against browsing history and erases the matching entries, either as the user browses, when the browser closes, or at the start of the next session. Cache, cookies and site data, download history and saved form text are cleared only when the user turns that switch on and asks for it. It has no other function.
```

### 3b. Permission justifications (max 1000 characters each)

**history**

```
Required to read browsing history so the extension can find the entries matching the rules the user entered, and to delete only those entries. This is the extension's entire function. History is processed locally on the device, is never transmitted anywhere, and is not read for any other purpose.
```

**storage**

```
Keeps the user's rules, their settings and an optional local log of wiped entries in browser storage. Settings and the log stay on the device. The rule list is stored in the browser's synced extension storage so it follows the user to their other signed-in devices; that transfer is performed by the browser's own sync, is never seen by the extension, and carries nothing but the rule list.
```

**notifications**

```
Displays an optional desktop notification after a wipe reporting how many entries were removed. The user can switch it off in the extension's settings.
```

**contextMenus**

```
Adds two right-click menu items that let the user add the current page, or the site it belongs to, to their rule list without opening the options page.
```

**activeTab**

```
Used only after the user clicks the extension's toolbar button. The popup reads the address of the current tab so it can offer to wipe that site or that page. Page content is not read.
```

**browsingData**

```
Used only by the four optional clear switches (cache, cookies and site data, download history, saved form text). They are off by default; with them off the API is never called. When the user turns one on and presses the clear button, the extension calls chrome.browsingData.remove for the data types and the time span the user selected. Nothing read from this API is stored or transmitted; the reply carries no data, so no count is shown. Passwords are not requested through this API.
```

### 3c. Remote code

Select **"No, I am not using remote code."** Leave its justification field empty.

### 3d. Data usage — which boxes to tick

Tick **Web history / Online history** only. Leave the other eight unticked.

Reason, from Google's own User Data FAQ: "handle" covers collecting, transmitting,
*using* or sharing, and it names "collecting web browsing activity ... including the
domains or URLs the browser interacts with". The FAQ also states plainly that disclosure
is required "even when data is processed or stored locally on a user's device and is not
transmitted to external servers or third parties". An extension holding the `history`
permission that declares nothing is exactly the inconsistency that gets a version
rejected.

Unticked and correct: identification, health, financial and payment, authentication,
personal communications, location, user activity, website content. The extension never
touches any of them.

The extra clear does not change those boxes. It deletes local browser data at the user's
request; it reads nothing out of it, keeps nothing from it, and sends nothing.

One nuance to be aware of: the rule list lives in the browser's synced storage, so a user
with sync switched on has it carried between their own signed-in devices by the browser.
That is the user's own browser sync rather than a transfer by the extension, and rules are
not browsing history. The policy at 3f says so explicitly, and the two must agree.

### 3e. Certifications

Tick all three. All are true: nothing is sold or transferred to third parties, nothing is
used for purposes unrelated to the extension's single purpose, and nothing is used for
creditworthiness or lending.

### 3f. Privacy policy URL (required, field takes up to 2048 characters)

The FAQ makes this mandatory even for local-only storage.

**Live URL, ready to paste into the dashboard field:**

```
https://forsigh.github.io/lil-bro-history-wipe/privacy.html
```

Served by GitHub Pages from `docs/` on `main` of the public repo
`https://github.com/Forsigh/lil-bro-history-wipe`. It is already published and returning 200.
If you ever change the policy, edit `docs/privacy.html`, commit and push: Pages rebuilds in
about a minute. Once published, do not let the hosted policy drift from what the dashboard
declares, since discrepancies between the two are treated as a policy violation.

The policy now has a section on the extra clear, which is what the browsing-data
permission is for. It has to, before this version goes up.

---

## 4. Still needed before you can submit

1. **Developer account.** One time 5 USD registration fee, then verify the email.
2. **Screenshots.** At least one, 1280x800 or 640x400. Rejected listings are usually
   missing icon or screenshots. The screenshots on the current listing show the old popup,
   so they need replacing with the compact one.
3. **Promo tile.** `store/promo-440x280.png` is already generated; the store says it is
   mandatory.
4. **128x128 icon.** Already in `icons/icon128.png` and referenced in the manifest.
5. **Category and language.** "Privacy & Security" is the closest fit.
6. **Package.** `builds/lil-bro-history-wipe-1.2.0.zip`: manifest.json sits at the root of
   the zip, the manifest has no comments, and every file it references is present. Each
   future upload needs a higher version number.
7. **Privacy policy URL** from 3f, hosted somewhere public.

## 5. What users will see at install

Chrome attaches this warning to the history permission and it cannot be narrowed:

```
Read and change your browsing history on all your signed-in devices
```

The other five permissions produce no warning. `browsingData` is the one to be ready to
explain if a reviewer asks: it exists for the four optional clear switches, the switches
ship off, and the justification at 3b says so in the same words the code uses.

Two things to note about shipping 1.2.0 to the existing installs:

1. Chrome disables an extension on update when the update adds a permission that produces
   a **new warning**, and prompts the user to re-enable it. `browsingData` produces no
   warning, so this update should land silently. That is the reading of Chrome's own
   documentation, not a guarantee, so watch the install count after the update rolls out.
2. The store listing text, the screenshots and the hosted privacy policy all have to match
   the new behaviour before the upload, or the review will catch the mismatch.
