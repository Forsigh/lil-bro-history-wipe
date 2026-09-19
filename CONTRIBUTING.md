# Contributing

Issues are welcome, and so are fixes.

- Small pull requests. One change each, and say in the description what you tested it with.
- `npm test` runs all seven suites. `node tools/live_probe.mjs <port> <browser>` drives the real
  extension in a throwaway profile. A change to either page has to keep both green.
- `python tools/package.py` builds the zip the store gets. It refuses to write one unless every entry
  matches this folder, so it is the last check before a release.
- No new permissions, no network calls, and nothing that phones home. Those are the rules the
  extension is built on, and a pull request that breaks one will be turned down however good it is.
