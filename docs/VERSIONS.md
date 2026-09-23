# Versions

One version number is one build. Any change to a shipped file means a new number,
and the old zip is never overwritten. That rule broke on 1.3.0: six commits landed
after it was built and the zip was rebuilt under the same name three times, so three
different builds called themselves 1.3.0. The current code is numbered 2.0.0.

| Version | Built | Commit | Zip sha256 (16) | Note |
|---|---|---|---|---|
| 2.0.0 | 23 Sep | `a835da1` | `53cf87c162ae553b` | Export is a full setup file now. It always carried your list and your settings; it also |
| 1.10.0 | 23 Sep | `4748907` | `15ad255ab7ed96eb` | Export is a full setup file now. It always carried your list and your settings; it also |
| 1.9.1 | 23 Sep | `4be63cf` | `e4cdd9cac8ef9508` | The switches on your list are switches now. They used to draw as a tick on a pill, which reads as a broken checkbox rather than something you can flip. Each one is a round knob on  |
| 1.9.0 | 23 Sep | `7c7bf2c` | `3dbd181d9f4483cc` | The settings page is three tabs now. Cleaning is what it always was: when it cleans, what gets cleaned, your list, and the two run buttons. Logs holds what it has cleaned and the s |
| 1.8.0 | 23 Sep | `201ba82` | `eee630531cfa8981` | Every switch in this thing is the same object now, and it is drawn from the theme's own colours. That goes for the on/off boxes on your rule rows, the button in the popup, and the  |
| 1.7.9 | 23 Sep | `44f3bb8` | `37594d8c479bd67c` | The settings page is a lot shorter to look at. What you change day to day is what you see when it opens: when it cleans, what gets cleaned, your list, the two run buttons, the look |
| 1.7.8 | 22 Sep | `4d873a3` | `1d5ef9227f2f7be9` | A rule can be told never to delete now. Mark a site that way and it stays in your history whatever else matches it, which is what you want for the bank you check every morning or t |
| 1.7.7 | 22 Sep | `0e0fe41` | `66f4f0c3b015cc13` | Escape closes the delete confirmation now instead of leaving you sitting in it, and the focus goes back to the button you came from. The stylesheet lost a set of rules that had bee |
| 1.7.6 | 22 Sep | `4a40459` | `dd2fe3d43e6ef198` | Press Alt+Shift+W on any page to take that site out of your history right then, without opening |
| 1.7.5 | 21 Sep | `9937210` | `3db5165cd9cd5c19` | The popup and the settings page work again, and this is what was actually wrong. The file that turns a log entry into a readable line, src/logtext.js, was never added to the list o |
| 1.7.4 | 21 Sep | `1a7310b` | `0888d922bf846956` | If something goes wrong while the popup or the settings page is starting, the extension says so now. Both of them used to sit on the word "Loading" for good, with every control dea |
| 1.7.3 | 21 Sep | `e6beca4` | `a66eb645dbef1f03` | Nothing on screen changes. The code behind it lost some weight. |
| 1.7.2 | 21 Sep | `bd67199` | `883f8cf1e3fa015b` | The High contrast theme is readable now. Every button in that theme was painted the accent yellow, including the ones that write their own words in white or grey: the "Forgot the P |
| 1.7.1 | 21 Sep | `569fd75` | `eb169e70be926063` | The Language row is just the picker now. The line under it explaining that Auto follows the browser, and that more languages get added as they are written, is gone: the menu alread |
| 1.7.0 | 21 Sep | `238637a` | `3791fd6aedc601ca` | The Polish version is Polish all the way through. Every line the extension can put in front of you now comes out of the language file, including the ones that were still written in |
| 1.6.1 | 21 Sep | `29206bb` | `bd7bf9df462bcc00` | The popup no longer asks for the PIN. It used to put up a box that you typed into, and which then simply disappeared, which protects nothing and makes the extension look broken. Wi |
| 1.6.0 | 21 Sep | `e8b2fd1` | `57136ccc5b0f5cc0` | What it cleaned now reads as a list of pages instead of a list of addresses. Every row leads with what the page called itself, so the thing you watched reads as "2 Gay Guys dancing |
| 1.5.9 | 21 Sep | `aba4b2e` | `98792e646d405dbb` | The settings page and the popup both print a line about where your things are kept, and the two had drifted apart. The popup said everything you add stays on this computer while th |
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
| 1.4.2 | 19 Sep 23:23 | `4ee110a` | `b31577a4605893ed` | the name: Lil Bro Wipe – History Cleaner, in the package, on both pages, in the listing copy and in the build file name |
| 1.5.0 | 19 Sep 23:58 | `1b1b2ce` | `0176d9b603b2e704` | the look: a new sheet, eight themes with measured contrast, and the popup stops saying the same sentence twice |
| 1.5.1 | 20 Sep 00:09 | `9ebb333` | `fa3ce5deab060375` | two themes tuned after seeing them rendered: Midnight lifted off true black, High contrast flattened with its control borders at 5.3:1 |
| 1.5.2 | 20 Sep 00:28 | `6201dd8` | `ae2592fc4725e47d` | the settings page stopped naming what you add while the PIN is on, and the address tester goes quiet with it |
| 1.5.3 | 20 Sep | `c67ea3c` | `230b1e58885e90bd` | an update from 1.3.5 was tested for real: settings, rules, PIN, log and counters all survive, and a list that only lived in sync gains the local copy it was missing |
| 1.5.4 | 20 Sep | `53fb872` | `4ea4a85a22251f8d` | the guards that keep frequent updates safe: version agreement across the table, the zips and the changelog, a frozen settings shape, and a backup file from an old build importing through the real picker |
| 1.5.5 | 20 Sep | `55ec82c` | `308fcef5f736291d` | the theme buttons stopped lying about their colours, the language picker is one small menu, and the settings page stopped describing where your rules go |
| 1.5.6 | 20 Sep | `61df863` | `c22fb27f6b1dc3e1` | the English fallbacks in the markup catch up with the strings the pages actually show, so what a translator reads is what ships |
| 1.5.8 | 20 Sep | `934180d` | `291ae9cd062b9a3f` | the rule list stops living in the browser's synced storage: it is local like everything else, an older list is moved across once and the synced copy deleted, so the policy, the settings page and the listing can all say nothing leaves this computer |
| 1.5.7 | 20 Sep 23:16 | `0235e18` | `fe56d8d79dba9295` | one control column, the page state at the top, the picker's arrow back |

Zips for 1.0.1 through 1.3.1 are kept in `builds/` in the store-assets folder on the
Desktop. A zip is the contract: if the bytes differ, the version has to.

## Rule for the next release

1. Change files, run `npm test` and the live probe.
2. Bump `version` in `manifest.json` (the store refuses a number it already has).
3. Rebuild the zip under the new number. Never write over an existing zip.
4. Add the row above with the real hash, then upload.
