# What changed

Newest first. A short note per release, and only what you would notice using it.

## 1.9.0

The settings page is three tabs now. Cleaning is what it always was: when it cleans, what gets cleaned, your list, and the two run buttons. Logs holds what it has cleaned and the sites no rule covers yet. Advanced holds everything that needs a sentence of explaining first: the look and the language, the PIN, the cookies, the address tester, the import and export, and the switch that ignores your list.

While the PIN is on, the Logs tab is greyed out and does not open. The log names the sites it cleaned, so it stays out of reach until you unlock. A locked page opens on Advanced, on the card with the PIN box in it, because that is the only thing you can usefully do from there. Unlocking brings you back to your list.

How it cleans has not changed: same rules, same counts, same storage, no new permissions. Nothing was removed from the page either. It is the same set of controls, arranged so the first thing you see is the part you change.

## 1.8.0

Every switch in this thing is the same object now, and it is drawn from the theme's own colours. That goes for the on/off boxes on your rule rows, the button in the popup, and the way into the advanced half at the bottom of the settings page. That last one deserved the complaint: it was a full-width strip with a bare checkbox floating in the middle of it. It is a switch with its label beside it and a line of plain words under it now.

The language menu moved in with the rest of the fine-tuning, behind that same switch. The coffee link at the bottom is the banner from the README, and the button under it says the same thing it always did.

The rest of the pass: the theme tiles sit four to a line instead of leaving the last one alone on a line, the small text under a row lines up with the label above it, the rule box is one line tall with no corner left to drag out of shape, the option cards got room between their title and their description, and an empty list now offers a button that puts the cursor in the box above instead of just telling you to go find it.

## 1.7.9

The settings page is a lot shorter to look at. What you change day to day is what you see when it opens: when it cleans, what gets cleaned, your list, the two run buttons, the look and the language. The PIN lock, the log, the cookies, the address tester, the import and export and the everything-switch moved under one toggle at the bottom, and that toggle says how many controls are waiting there, so nothing is hidden by surprise. Opening the page used to put fifty-seven controls in front of you. It is twenty-nine now.

The popup no longer prints its version number in the corner. The settings page still carries it for when it is needed.

One small addition, seen once: after an update, the first time you open the popup, a note says what changed in that version. Press it away and it stays away until the number moves again. On a brand new install it never appears, because for somebody who was not here for the old build, nothing changed.

## 1.7.8

A rule can be told never to delete now. Mark a site that way and it stays in your history whatever else matches it, which is what you want for the bank you check every morning or the forum you keep going back to. The promise holds on the two paths that do not consult your rules: the full sweep walks the entries one address at a time instead of clearing everything, and the keyboard wipe on a site marked this way tells you it kept the site rather than pretending to have cleared it. Marking it is one button on the rule row.

Both pages say more than they used to. The popup opens with how much it has kept out of your history altogether, and a card under that naming the rules which have caught the most. The settings page opens with the same total, every rule row says how many entries that rule has removed, and there is a screen listing the sites you visit that no rule covers yet, so you can see what is slipping past. There is also a box on the rules page for pasting a whole list of sites at once, instead of adding them one at a time.

Two limits are written down rather than glossed over, in the README and in the privacy note: the browser's own allow list cannot be read by the extension, and deleting happens on this computer only, so a copy on another machine is out of reach.

## 1.7.7

Escape closes the delete confirmation now instead of leaving you sitting in it, and the focus goes back to the button you came from. The stylesheet lost a set of rules that had been written twice and a button style nothing used, 46 lines gone in total. The test suite also learned to check that every control on the popup and the settings page is a real button, so a future edit cannot leave one of them keyboard-unreachable.

## 1.7.6

Press Alt+Shift+W on any page to take that site out of your history right then, without opening
the popup and without adding anything to the list. It takes the entries for the site you are on
and nothing else, because it does the same work a rule for that site would do, so it cannot reach
past the address you are looking at. The keys can be changed on the browser's own shortcuts page.

A new check watches what the extension promises rather than what it does. Nothing in the package
can make a request, the only real address in it is the support page, and the permissions it asks
for are exactly the ones the README names. If any of that stops being true the tests fail, rather
than the listing quietly going wrong.

Wipes now say how many entries went, in your language, with the count written the way Polish
wants it. The Export row says what the file is for: moving your list to another computer. Wording
that no longer belonged to anything is gone from both language files.

## 1.7.5

The popup and the settings page work again, and this is what was actually wrong. The file that turns a log entry into a readable line, src/logtext.js, was never added to the list of files the package is built from. It came into the project with the log rewrite in 1.6.0 and stayed out of the package from then on, so every build from 1.6.0 to 1.7.4 shipped a popup and a settings page that could not load at all. What you saw was the page's first paint, the word "Loading", with the settings button doing nothing, because the script that draws the page and wires that button up never ran.

Nothing here caught it because every check reads the working tree, where the file is present. Two now look at the package itself: the packager refuses to write a zip when a script imports something its own file list does not carry, and a new suite opens each built zip and checks the same thing inside it, so the artifact is judged as well as the tree. The seven builds that shipped this way are named in that suite one at a time, so the exemption cannot quietly grow to cover the next real failure.

1.7.4 said this was a folder being written while the browser read it. That was wrong. The folder was fine, and this was the reason.

## 1.7.4

If something goes wrong while the popup or the settings page is starting, the extension says so now. Both of them used to sit on the word "Loading" for good, with every control dead, which tells you nothing and looks like the extension died. The state now turns into "Could not start" with one line saying what to do about it, and the reason itself goes to the browser console where it can be read.

That is what you ran into: the folder on disk was fine, and the extension had been read from it while a release was still writing it out. The handover now builds each load-unpacked folder off to one side and moves it into place in a single step, so a browser can never be pointed at a half-written one, and it checks the copy against the zip before calling it done. Two empty folders left there by an earlier failed unpack are gone, and no release can leave one behind now.

The browser check also opens both pages in a profile with nothing stored at all, no rules, no settings and no log. It passed. Nothing had ever tried that state before, and it is the one a new install starts in.

## 1.7.3

Nothing on screen changes. The code behind it lost some weight.

The rule that turns whatever you paste into a plain domain was written out twice, once beside the matching code and once beside the state helpers. There is one copy of it now, and it lives with the matching.

Three pieces of code that nothing called are gone, and so are three wording entries in both language files that only those pieces used. One of them said "Instantly, as I browse", which the settings page stopped saying a while ago: the row that picks when the cleaning happens has its own wording, and it was never the same sentence.

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
