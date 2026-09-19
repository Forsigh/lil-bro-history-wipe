# Lil Bro - History Wipe

A Chrome and Brave extension that keeps the sites and words you choose out of your browsing history.
It works while you browse, when you close the browser, or at your next start. No account, no server,
nothing sent anywhere.

## What it does

You give it a list, and anything on that list is what it goes after:

- a site, `example.com`, with or without its subdomains
- one page, `https://example.com/private`
- a word, matched against the address and the page title
- a pattern, when you want to be exact

Matching entries leave your history. Nothing else moves.

Chrome holds more than history. Cache, cookies, the download list and text you typed into forms sit
behind four presets, off until you switch one on, and they run when you press a button or, if you
ask, at close and start.

## Install

From the Chrome Web Store, or by hand:

1. Open `chrome://extensions` and turn on Developer mode
2. Choose **Load unpacked** and pick this folder
3. Pin the icon, then open **All settings**

## Knowing what will be cleaned

Open the popup on any page and it tells you what happens to that page: whether it is one of the ones
that goes, and whether it goes as you browse or at your next start. From the same screen, one click
adds the page to your list or takes the site off it.

## What it is honest about

- Passwords are not touched. Chrome removed that for extensions, so there is no switch for it.
- Chrome cannot narrow history, downloads or form text to a single site, so those go for the span
  you chose rather than per site.
- Chrome will not run anything at the exact moment the browser closes, so a clean set for close
  happens at your next start. You will not notice.
- An address you deleted can still appear in the address bar suggestions.
- A deleted cookie takes the whole site with it, so you are signed out there afterwards.
- Your list can travel between your computers through your own browser account. The log of what was
  cleaned never leaves this one.

There is a PIN you can put on the list, so nobody using the same computer can read it, and six
themes if you care how it looks.

## Support

One person, no server bill, just the hours: [Buy me a coffee](https://buymeacoffee.com/forsigh).

Something broken, or a Polish line that reads like a machine wrote it?
[Open an issue](https://github.com/Forsigh/lil-bro-history-wipe/issues).

## Privacy

Everything ships inside the package. No remote code, no analytics, no network requests of its own.
The one link out is the support page, and your browser opens it in a new tab only if you click it.
The long version is in [the policy](https://forsigh.github.io/lil-bro-history-wipe/privacy.html).

Permissions: `history` (the only one Chrome warns about), `storage`, `notifications`,
`contextMenus`, `activeTab`, `browsingData`, `cookies`. No host permissions, no content scripts.
`tabs` is optional and asked for only by the cookie-on-tab-close setting.

## Under the hood

No build step and no dependencies.

```
npm test                       # all six suites
node tools/live_probe.mjs 1234 <browser>   # the extension itself, in a throwaway profile
python tools/package.py        # the zip, verified entry by entry against this folder
```

`matcher.js` decides what matches, `service-worker.js` does the deleting, and both pages take their
words from `_locales`. `docs/VERSIONS.md` lists every zip with its hash, because one version number
means one zip and nothing gets rebuilt under an old name.
