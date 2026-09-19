# Versions

One version number is one build. Any change to a shipped file means a new number,
and the old zip is never overwritten. That rule broke on 1.3.0: six commits landed
after it was built and the zip was rebuilt under the same name three times, so three
different builds called themselves 1.3.0. The current code is numbered 1.3.1.

| Version | Built | Commit | Zip sha256 (16) | Note |
|---|---|---|---|---|
| 1.0.3 | 17 Sep 19:32 | `5fae5dc` | `d5ce8de46680c92b` | live on the store per the maintainer |
| 1.0.4 | 17 Sep 20:09 | `f71544b` | `e83b5ffc449571fb` | |
| 1.0.5 | 17 Sep 20:50 | `486c634` | `6b6c62cdd9a651f3` | |
| 1.1.1 | 17 Sep 21:09 | `cd1b8b9` | `13afff0cc95a25af` | |
| 1.2.0 | 18 Sep 18:48 | `660d9d7` | `4c2f15f8d2f77bc1` | extras, compact popup, options rewrite |
| 1.3.0 | 18 Sep 20:10 | `2ad778e` | `9acf516f84124f2a` | label only: rebuilt three times under this name, so this hash is not what 1.0.x-era uploads looked like |
| 1.3.1 | 18 Sep 20:56 | `94ad476` | `4d8bd6955ec83506` | presets with plain explanations, PIN under "When should it clean?", advanced controls behind one switch, en + pl |
| 1.3.2 | 18 Sep 21:09 | `eb9ba4b` | `7d477d77bdf392eb` | list and log back on the first screen (PIN still hides them), advanced slimmed, every visible string rewritten in plain English and Polish |
| 1.3.3 | 18 Sep 21:26 | `c430089` | `64de55c68c8b91ab` | preset rows say what each one costs you, Nuclear renamed FULL and red, "when I close the browser" dropped, adding to the list works while the PIN is on |
| 1.3.4 | 18 Sep 21:32 | `d5b994a` | `5e6e69c7b9202833` | "Preview" is now "Scan" on both pages (en) and "Sprawdź" (pl) |
| 1.3.5 | 18 Sep 21:39 | `45b69e1` | `e44de5afcd9ed641` | popup cut to what a person actually uses: status, add to filter list, wipe now, scan, settings link. No compact/classic switch, no "more controls", no counters. "Skanuj" in Polish |
| 1.3.6 | 18 Sep 21:47 | `79d63b8` | `fbcbf6ee3e9ab66b` | Language row in settings: Auto (the browser), English, Polski. The pages read the bundle themselves, so the setting beats the browser's own choice |
| 1.3.7 | 18 Sep 21:55 | `9af2307` | `f51df3e6cc2eb82f` | popup labels now actually translate (the label pass ran before the language loaded, so Polish showed "Scan"); "Added." without the site name while the PIN is on |
| 1.3.8 | 18 Sep 22:58 | `6cc4021` | `10c6d8edafc126d3` | both languages rewritten in the plain register: "Arm" is now "Full wipe", each preset line says what changes for you, definitions sit in the sentence that uses the word. Polish keeps Wł. / Wył. |
| 1.3.9 | 19 Sep 07:35 | `01f9c66` | `c76700d51a93b624` | your new icons, the four from graphics/icons. Full bleed and opaque where the old mark was a transparent glyph. Same filenames, so nothing in the manifest moved |
| 1.3.10 | 19 Sep 16:58 | `1294f39` | `7c47c8f9ce7bdfcc` | the icon replaces the "LB" tile in the popup header and the settings header |
| 1.3.11 | 19 Sep 18:40 | `49762c3` | `bdda335ffc7476c2` | one link out: Buy me a coffee, bottom of the settings page. Plain anchor, no script and no remote image, so the remote-code answer stays no |
| 1.4.0 | 19 Sep 19:26 | `2e45954` | `02d5d06575d334e9` | the popup says what happens to the tab in front of you, red for a page that goes, calm for one that stays. The dead compact/classic code is gone from the page, the tests and the probe. README and the landing page rewritten shorter, and the packager taught the files it had been missing |
| 1.4.1 | 19 Sep 20:01 | `386c99b` | `1a0d59b7a63fdc6d` | the code moved into src/ and the copy stops naming one browser brand: it says the browser, since every Chromium one behaves the same. Nothing about the extension itself changed |

Zips for 1.0.1 through 1.3.1 are kept in `builds/` in the store-assets folder on the
Desktop. A zip is the contract: if the bytes differ, the version has to.

## Rule for the next release

1. Change files, run `npm test` and the live probe.
2. Bump `version` in `manifest.json` (the store refuses a number it already has).
3. Rebuild the zip under the new number. Never write over an existing zip.
4. Add the row above with the real hash, then upload.
