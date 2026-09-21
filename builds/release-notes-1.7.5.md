## 1.7.5

The popup and the settings page work again, and this is what was actually wrong. The file that turns a log entry into a readable line, src/logtext.js, was never added to the list of files the package is built from. It came into the project with the log rewrite in 1.6.0 and stayed out of the package from then on, so every build from 1.6.0 to 1.7.4 shipped a popup and a settings page that could not load at all. What you saw was the page's first paint, the word "Loading", with the settings button doing nothing, because the script that draws the page and wires that button up never ran.

Nothing here caught it because every check reads the working tree, where the file is present. Two now look at the package itself: the packager refuses to write a zip when a script imports something its own file list does not carry, and a new suite opens each built zip and checks the same thing inside it, so the artifact is judged as well as the tree. The seven builds that shipped this way are named in that suite one at a time, so the exemption cannot quietly grow to cover the next real failure.

1.7.4 said this was a folder being written while the browser read it. That was wrong. The folder was fine, and this was the reason.
