# Releasing

One command, from a clean tree:

```
python tools/release.py 1.5.9
python tools/release.py 1.5.9 --probe 9521     # also drive the real extension first
python tools/release.py 1.5.9 --dry-run        # print the steps, change nothing
```

Write the release note first, to `builds/release-notes-<version>.md`: what changed and why it
matters to somebody using the extension, in the voice the changelog uses. The script copies that
note into `CHANGELOG.md` and into the GitHub release. It will not write release copy for you.

## What the command does, and what it refuses

It bumps `manifest.json`, inserts the note into the changelog, runs every suite except the
release agreement, optionally probes the extension in a real browser, packages the zip, writes
the row into `docs/VERSIONS.md` with the hash of the zip it actually built, runs the release
agreement now that there is something to agree with, commits, pushes, publishes the GitHub
release with the zip attached and reads it back, then delivers to the Desktop folder: the zip,
a `load-unpacked-<version>` copy, the `UPLOAD-<version>` folder with the screenshots and the
artwork, the checked store listing, and an updated `README.txt`.

It refuses on a version that is not newer, a version whose zip already exists, a missing or stub
note, a dirty tree, a suite that is failing, a probe that is failing, a zip the packager will not
write, and a release the GitHub API does not confirm back with the asset attached. Nothing is
pushed or published until the release agrees with itself.

Two steps are still yours, because they need your account:

1. **Upload the zip.** Chrome Web Store has no publishing API for this account, so the build goes
   up by hand. The dashboard fields are in `store-listing/`, one block per field, ready to paste.
2. **Roll back if it goes wrong.**

## Rolling back

Rollback is a dashboard action, not an API call: the Web Store API v2 has upload, publish and
status, and no rollback endpoint. In the dashboard, open the item, and the version history under
Package offers a roll back to a previously published version.

Two things to know before you need it, because they decide which move is the right one:

- A rollback restores the older version in the store and stops the newer one being served. It
  does not downgrade a copy a user already updated: Chrome updates upward, so anyone who
  received the bad build stays on it until you ship a fix. That is my reading of how the update
  mechanism behaves, worth confirming in the dashboard during the drill below.
- Therefore a rollback is how you stop new installs receiving a bad build. A fix forward is how
  you repair the users who already have it. Both may be the right answer at once: roll back to
  stop the spread, then ship the fix as the next version.

Do the drill once, while nothing is wrong, so the path is familiar when something is: open the
dashboard, find the version list, and look at what a rollback would do to the current version.
Do not confirm it.

## Conventions this keeps

- **One version number is one zip.** The script refuses to reuse one, and refuses to build under
  a version the manifest does not carry.
- **Bump before building**, never after, so the number inside the package always matches the
  number in the release.
- **A clean checkout has no zips** (`builds/*.zip` is ignored), so the release agreement reports
  `skipped` there instead of failing. CI runs the suites on a clean tree for that reason.
- **The store listing lives in `store-listing/`**, checked by `tests/listing.test.mjs` against the
  package, and copied to the Desktop by the release script rather than edited there.
