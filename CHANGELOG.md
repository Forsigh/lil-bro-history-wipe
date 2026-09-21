# What changed

Newest first. A short note per release, and only what you would notice using it.

## 1.7.2

The High contrast theme is readable now. Every button in that theme was painted the accent yellow, including the ones that write their own words in white or grey: the "Forgot the PIN?" button, the theme pills, and the notes under each preset were yellow on yellow, which is the opposite of the one thing that theme exists to do. The yellow now stays on the buttons that are solidly an accent button, and the rest keep the fill they were designed with. The On/Off switch was the worst of them, because it says its own state in the accent colour, so it keeps a clear body and picks up an outline instead.

Two smaller things came out of the same measurement. The list that opens from a dropdown is drawn by the browser rather than by the closed control, so it was using the control's own text colour, which in the light themes meant white words on a white list. Those options now carry their own background and colour. And six theme colours sat a hair under the readable minimum: the accent in Light and Paper, the warning colour in Paper, and the muted grey in Light, Paper, Neon and Slate. Each one moved by a channel or two, which you would not notice, and every theme now clears the same bar.

The release run measures every word on both screens in all eight themes against the colour actually behind it, so this cannot come back quietly.

## 1.7.1

The Language row is just the picker now. The line under it explaining that Auto follows the browser, and that more languages get added as they are written, is gone: the menu already says "Auto (my browser)", and a sentence about how the project is going has no business on a settings screen.

The screenshots were re-shot, because that card appears in one of them.

## 1.7.0

The Polish version is Polish all the way through. Every line the extension can put in front of you now comes out of the language file, including the ones that were still written into the code itself: the PIN messages, both confirmation dialogs, the right-click entries, the notifications, the status lines on the settings page, the answers under "Check an address", every error and every note beneath a switch. Around a hundred and thirty strings moved across, so a Polish build no longer shows an English sentence anywhere.

Those lines sat in the code rather than in the language file, which is exactly why they stayed English while the rest of the page changed with the setting. A new check now walks every script that draws text and fails if a sentence is not looked up, so the same gap cannot quietly open again, and the release run reads the rendered Polish pages and searches them for English sentences before it will build a zip.

## 1.6.1

The popup no longer asks for the PIN. It used to put up a box that you typed into, and which then simply disappeared, which protects nothing and makes the extension look broken. With the PIN on, the popup now keeps working: the switch, the two runs and adding the site in front of you all stay, and one line says that the list is hidden and where to unlock it.

The list itself stays off that screen while the PIN is on, and so does the line about what happens to the tab you are looking at, so nothing on the list is readable by whoever is standing at the computer. The settings page is still where the PIN is set, changed and recovered, and it behaves exactly as before.

## 1.6.0

What it cleaned now reads as a list of pages instead of a list of addresses. Every row leads with what the page called itself, so the thing you watched reads as "2 Gay Guys dancing in the kitchen" rather than two kilobytes of sign-in token with the matching letters buried past the first screen. Under the title is the reason in words: which word matched, and whether it matched the address or the page title. Below that is when it happened and the site it came from.

When a word matched somewhere inside an address, the row now shows the neighbourhood of the match rather than the whole thing. That is the part that stops the list looking like the extension invented a reason, because you can see the letters sitting in the token that caught them.

Rows written by an earlier build still show what they always did, so a log that already exists keeps its meaning. The popup's preview of what a scan would take reads the same way as the log now, since it is the same wording.

## 1.5.9

The settings page and the popup both print a line about where your things are kept, and the two had drifted apart. The popup said everything you add stays on this computer while the settings page still said your settings stay, which was true but weaker, and a sentence that only covers settings invites the question of what happened to the list. Both say it the same way now.

The store listing moved into the repository, and the suite checks it against the package: every permission has a justification and no justification describes a permission the extension no longer asks for, each field fits the length the dashboard allows, and no file claims something the code does not do. A Polish walkthrough still told the reader to upload 1.5.7, which is exactly the kind of sentence that goes stale in silence, so it names no version now.

Releases also have one way through instead of six. `python tools/release.py 1.5.9` bumps the version, inserts the note, runs the suites, packages the zip, writes the table row with the hash of the file it actually built, publishes the release and delivers everything to the Desktop folder, stopping at the first thing that is not true. The copy of the privacy policy that a reviewer reads in the store is now the same file as the one the listing links to, and a test says so, because the two had already drifted.

## 1.5.8

Everything this extension saves now lives in one place on your computer, the rule list included. That list used to sit in the browser's synced storage, which meant your browser would upload it if you had sync switched on, and a list of the sites you would rather not keep is not something to hand to an account you never asked for. A list from an older build is moved across the first time the extension starts, and the copy in the synced area is deleted, so nothing of yours is left there. The privacy policy, the settings page and the store listing now say the same thing, because they can.

## 1.5.7

The settings page lines up now: every row's text starts at the same place, a note under a row sits
under the label it explains instead of off to the left, and a thin rule separates the pick-one rows
from the on and off ones, which used to differ by four pixels of margin. The top of the page says
what it is doing before you scroll, so you can see what is on, how many rules you have and when it
last cleaned without hunting for it. The language menu has its arrow back, which the stylesheet had
been painting over, and a Polish page reads Polish there and shows 24-hour times instead of 10:12
PM. The eight theme buttons do not fit a narrow window, so below about 700 pixels they form two rows
of four rather than wrapping seven and one, and one of them is called Contrast now.

## 1.5.6

The English fallback text in the markup had fallen behind the English the pages actually show, in
fifteen places on the settings page and three on the popup: it still said Arm where the button says
Full wipe, still named one browser brand after the copy stopped doing that, and still carried the
old line about rules following you between computers. The fallbacks are what a translator reads and
what shows if a bundle is missing, so they now read exactly like the strings they stand in for.

## 1.5.5

The theme buttons on the settings page now draw a preview of each theme in that theme's own
colours, so a theme that gets adjusted takes its button with it. Paper's had been showing the
old brown since the colours moved, and Auto's showed two colours that meant nothing. The
language choice is one small menu with an arrow instead of three full-width rows. The line at
the bottom of the page names what stays on this computer instead of describing where your
rules go.

## 1.5.4

Nothing changes in the app itself. This release is the safety net for the next ones: a backup file from an old build is now fed to the current importer by a test, the zips, the versions table and the changelog are checked against each other on every run, and the shape of everything saved is frozen so a renamed setting fails the build instead of quietly losing someone's list. The live probe also stopped pinning a version number, which used to break it on every bump.

## 1.5.3

Nothing you can see: this one is about what happens to your settings when the extension updates itself. A profile that was running 1.3.5 comes through with its switches, its keep list, its PIN, its theme, its log and its counters intact, and that is now covered by a test that feeds that old profile to the current build. One thing did change: if your list only ever lived in sync, it now keeps a local copy from the first read, so it still shows if sync goes away. The old close-the-browser trigger, dropped from the interface long ago, moves quietly to the next start.

## 1.5.2

Adding a site in the settings page printed the site, even with the PIN on, which is the one thing the PIN is there to hide. With the PIN off that line is gone: the new row in the list already says it. With the PIN on it reads Added and nothing more, and the address tester stays quiet too, because it answers with the name of the rule that matched.

## 1.5.1

Midnight's cards sat close enough to true black that the panels vanished on a dim screen, so they are
lifted now and a border does the separating. A shadow cannot be darker than black, which is why the
fill has to carry it. High contrast went flat: no gradients, no glows, and outlines bright enough to
count. Both were spotted by looking at the themes drawn, which is something no test does.

## 1.5.0

The look of both pages was rebuilt. Cards, buttons, fields, the switch: all new, one column for the
choices, and a focus ring you can see with a keyboard.

Two themes joined, so there are eight. Midnight suits screens that go true black, High contrast suits
bad light. Every theme was measured and the weakest contrast anywhere is 5.16 to 1.

The popup stopped printing the same sentence twice, and the way into settings reads as a link now.

## 1.4.2

The name is Lil Bro Wipe – History Cleaner now, on both pages, in the store pictures and in the
package. The build file follows: from this version on it is named lil-bro-wipe-<version>.zip.

## 1.4.1

The code moved into `src/`. Nothing about the extension itself changed: a browser still gets the same
thing. The root of this repo just reads like a project now instead of a pile of files.

## 1.4.0

The popup tells you what is about to happen to the page you are on. Open it on a site from your list
and a red dot says that page goes, with the trigger named. Pages that stay say so too, calmly. The
old switch that hid half the popup behind "more controls" is gone for good.

## 1.3.11

A small Buy me a coffee button at the bottom of the settings page. It is a plain link, so the
extension still makes no network requests of its own.

## 1.3.10

Your icon in the popup header and the settings header, where the "LB" letters used to be.

## 1.3.9

Your four new icons, and the store pictures rebuilt around them.

## 1.3.8

English and Polish rewritten so they read like a person wrote them.

## 1.3.7

The Polish labels translate now. Adding a site while the PIN is on says "Added" rather than naming
the site.

## 1.3.6

A language setting: Auto, English, Polski.

## 1.3.5

The popup cut down to four things: the state, add to filter list, wipe now, scan.

## 1.3.4

"Preview" became "Scan".

## 1.3.3

Every preset says what it costs you, and adding to the list works with the PIN on.

## 1.3.2

The list and the log came back to the first screen, and the wording was rewritten.

## 1.3.1

Presets with plain explanations, the PIN next to "when should it clean", and the advanced controls
behind one switch. English and Polish.

## 1.3.0

The first build under this name.

## 1.2.0

Clearing beyond history: cache, cookies, the download list, typed form text.

## Earlier

1.0.x through 1.1.1, the first builds. Their dates and hashes are in
[docs/VERSIONS.md](docs/VERSIONS.md).
