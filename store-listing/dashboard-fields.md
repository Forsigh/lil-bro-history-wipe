# Lil Bro Wipe – History Cleaner, dashboard fields

Ready to paste. Every field is the English (default) locale. Nothing here is longer than
the limit next to it.

## Read-only, straight from the package

- Title: `Lil Bro Wipe – History Cleaner`
- Summary: `Wipes the sites and words you pick out of your history: as you browse, or the next time you open the browser.`

Both are pulled from the uploaded zip, so the dashboard keeps showing the old wording until
the newest build goes up. The old text also promised a clean when the browser closes, which the app no
longer does.

## Description (16000)

```
Lil Bro clears the parts of your browsing history you would rather not keep. You give it a list, and anything on that list is what it goes after: a site, a word, the start of an address. The shop you keep coming back to, a forum thread, a name you typed once.

Adding something takes two clicks. Click the toolbar icon and add the page you are on, or right-click any page and pick it from the menu. There is nothing to set up first.

Then you decide when it works. It can clear as you browse, so an entry is gone the moment the page loads. Or it can wait until your next start, so the visit stays until you close the laptop. And when you add something new, a small switch under the add row (on by default) also takes out the older visits you already have for it, then tells you how many went.

History is the main thing, but if you want more, it can also clear cache, cookies, downloads and text you typed into forms. All of that is off until you turn it on. One thing to know: cookies go for the whole site, so you will be signed out of it. Anything on your keep list is never touched.

Everything happens on your computer. No account, no server, no analytics, nothing sent anywhere. The log of what was cleaned stays local and can be wiped any time, and you can put a PIN on the list so nobody else using this computer can read it.

A couple of things it can't do, so nothing surprises you later: passwords are off the table, the browser doesn't let any extension touch them. A clean set for browser close can't run at the exact second you close it, so it runs when you next open the browser. And downloads or form text clear for a time span, not per site, because the browser gives no finer way.
```

Each paragraph sits on one line, so the paste arrives as clean paragraphs instead of breaking mid-sentence where this file happens to wrap.

## Category

Privacy and security. Already set.

## Graphic assets

- Store icon 128x128: `graphics/icons/icon128.png`
- Small promo tile 440x280: `graphics/promo-440x280.png`
- Marquee 1400x560: `graphics/marquee-1400x560.png`
- Screenshots, all five exactly 1280x800, 24-bit PNG with no alpha, off the build you are shipping:
  `screenshots/all-languages/01-options-1280x800.png`, `02-list-and-log-1280x800.png`,
  `03-locked-1280x800.png`, `04-popup-1280x800.png`, `05-look-and-language-1280x800.png`

Put those in the "for all languages" slot. The Polish set in `screenshots/pl/` goes in the
Polish slot, which the listing shows to a Polish visitor instead.

## Promo video

Leave empty. There is no video.

## URLs

- Homepage: `https://forsigh.github.io/lil-bro-history-wipe/`
- Product page: same URL
- Help URL: `https://github.com/Forsigh/lil-bro-history-wipe/issues`
- Privacy policy: `https://forsigh.github.io/lil-bro-history-wipe/privacy.html`

The help URL is the same place the privacy policy sends people to ("open an issue on GitHub"),
so the two match.

## Adult content

No.

## Additional data (GA4)

Nothing. There is no analytics code in the package.

## Single purpose (1000)

```
Deletes the browsing history entries a user chooses. The user lists sites, subdomains,
keywords, address beginnings or patterns; the extension matches those against browsing history
and erases the matching entries, as the user browses or at the start of the next session. With
the extra switches on it can also clear cache, cookies, download records and saved form text
for the same list. It has no other function.
```

The current text says "when the browser closes", which the app no longer offers, and it leaves
out the extra data kinds that four of the permissions exist for. Both are fixed above.

## Permission justifications

history (1000)
```
Required to read browsing history so the extension can find the entries matching the rules the
user entered, and to delete only those entries. This is the extension's whole function. History
is processed on the device, is never transmitted anywhere, and is not read for any other
purpose.
```

storage (1000)
```
Stores the user's rules, their settings, an optional local log of what was cleaned, and the
PIN if the user sets one. All of it stays on the user's own device and none of it is
transmitted. The user can export the rules or clear the log at any time.
```

notifications (1000)
```
Shows one optional desktop notification after a clean, saying how many entries were removed.
The user can switch it off in the extension's settings; with it off, no notification is shown.
```

contextMenus (1000)
```
Adds two right-click menu items so the user can add the current page, or the site it belongs
to, to their rule list without opening the settings page.
```

activeTab (1000)
```
Used only after the user clicks the extension's toolbar button. The popup reads the address of
the current tab so it can offer to clean that site or that page. No page content is read.
```

browsingData (1000)
```
Required to clear cache, download records, site storage and saved form text for the domains and
keywords the user chose. These switches are off by default and only run for the list the user
set up, at the times they picked.
```

cookies (1000)
```
Required to read and delete cookies for the domains and keywords the user chose, so a site's
session and tracking cookies can be removed with its history. Cookies on the user's keep list
are left alone. Cookie names and domains are read on the device and never transmitted.
```

tabs (1000)
```
Optional, and only asked for when the user turns on clearing a site's cookies as its tab
closes. That feature needs the address of the tab being closed, which the extension keeps in
session storage, in memory, until the tab is gone. The permission is not requested for any
other feature, and is not requested at install.
```

## Remote code

No. Everything ships in the package: no remote scripts, no eval, no remote Wasm.

## Data usage

Check `Historia online` (web history). That is the data type the extension works with.

Leave the other eight unchecked. It does not read page content, does not track clicks, mouse or
keys, has no location code, no accounts, no messages, no payment or health data.

Check all three declarations: no selling or transferring data to third parties, no use beyond
the single purpose, nothing used for creditworthiness or lending.

The policy covers the PIN as of the 19 September 2026 update ("A PIN you set yourself, if you
switch the list lock on..."), so the description and the policy agree. Nothing left to add.

## Where the numbers stand

- The description passes the English style gate (`style_check.py --register docs`): 0 fails,
  one advisory warning.
- Field limits respected: description 1698/16000, single purpose 414/1000, longest permission
  justification 320/1000.
- The three statements in the privacy tab must all be checked or the form will not submit.
