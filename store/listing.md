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

What it does not touch: cookies, cache, passwords, downloads and site data. The
extension never asks for those permissions, so it cannot reach them.

Everything stays on your computer. No account, no server, no network requests.

Two things worth knowing before you install. Chrome only hands over browsing history
after you accept a warning about reading and changing it, and that warning cannot be
narrowed. And Chrome gives extensions no way to notice that the browser is shutting
down, so wiping on close does its work when the last window closes and, if that gets
missed, at the next launch.

---

## 3. Privacy tab

### 3a. Single purpose description (max 1000 characters)

```
Deletes the browsing history entries a user chooses. The user lists sites, subdomains, keywords, URLs or patterns; the extension matches those against browsing history and erases the matching entries, either as the user browses, when the browser closes, or at the start of the next session. It has no other function.
```

### 3b. Permission justifications (max 1000 characters each)

**history**

```
Required to read browsing history so the extension can find the entries matching the rules the user entered, and to delete only those entries. This is the extension's entire function. History is processed locally on the device, is never transmitted anywhere, and is not read for any other purpose.
```

**storage**

```
Stores the user's rules, their settings and an optional local log of wiped entries on the user's own device. Nothing stored here is transmitted or shared.
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

---

## 4. Still needed before you can submit

1. **Developer account.** One time 5 USD registration fee, then verify the email.
2. **Screenshots.** At least one, 1280x800 or 640x400. Rejected listings are usually
   missing icon or screenshots.
3. **Promo tile.** `store/promo-440x280.png` is already generated; the store says it is
   mandatory.
4. **128x128 icon.** Already in `icons/icon128.png` and referenced in the manifest.
5. **Category and language.** "Privacy & Security" is the closest fit.
6. **Package.** `lil-bro-history-wipe-1.0.3.zip`: manifest.json sits at the root of the
   zip, the manifest has no comments, and every file it references is present. Each
   future upload needs a higher version number.
7. **Privacy policy URL** from 3f, hosted somewhere public.

## 5. What users will see at install

Chrome attaches this warning to the history permission and it cannot be narrowed:

```
Read and change your browsing history on all your signed-in devices
```

The other four permissions produce no warning. Expect the warning to cost some installs
and mention it in the listing, which section 2 already does.
