## 1.7.4

If something goes wrong while the popup or the settings page is starting, the extension says so now. Both of them used to sit on the word "Loading" for good, with every control dead, which tells you nothing and looks like the extension died. The state now turns into "Could not start" with one line saying what to do about it, and the reason itself goes to the browser console where it can be read.

That is what you ran into: the folder on disk was fine, and the extension had been read from it while a release was still writing it out. The handover now builds each load-unpacked folder off to one side and moves it into place in a single step, so a browser can never be pointed at a half-written one, and it checks the copy against the zip before calling it done. Two empty folders left there by an earlier failed unpack are gone, and no release can leave one behind now.

The browser check also opens both pages in a profile with nothing stored at all, no rules, no settings and no log. It passed. Nothing had ever tried that state before, and it is the one a new install starts in.
