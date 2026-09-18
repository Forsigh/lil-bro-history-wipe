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
| 1.3.1 | 18 Sep 21:0x | `ebeeca9` + this commit | `4d8bd6955ec83506` | presets with plain explanations, PIN under "When should it clean?", advanced controls behind one switch, en + pl |

Zips for 1.0.1 through 1.3.1 are kept in `builds/` in the store-assets folder on the
Desktop. A zip is the contract: if the bytes differ, the version has to.

## Rule for the next release

1. Change files, run `npm test` and the live probe.
2. Bump `version` in `manifest.json` (the store refuses a number it already has).
3. Rebuild the zip under the new number. Never write over an existing zip.
4. Add the row above with the real hash, then upload.
