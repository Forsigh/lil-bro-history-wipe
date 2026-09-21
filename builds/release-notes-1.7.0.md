## 1.7.0

The Polish version is Polish all the way through. Every line the extension can put in front of you now comes out of the language file, including the ones that were still written into the code itself: the PIN messages, both confirmation dialogs, the right-click entries, the notifications, the status lines on the settings page, the answers under "Check an address", every error and every note beneath a switch. Around a hundred and thirty strings moved across, so a Polish build no longer shows an English sentence anywhere.

Those lines sat in the code rather than in the language file, which is exactly why they stayed English while the rest of the page changed with the setting. A new check now walks every script that draws text and fails if a sentence is not looked up, so the same gap cannot quietly open again, and the release run reads the rendered Polish pages and searches them for English sentences before it will build a zip.
