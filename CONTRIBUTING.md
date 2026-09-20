# Contributing

Issues are welcome, and so are fixes.

- Small pull requests. One change each, and say in the description what you tested it with.
- `npm test` runs every suite. `node tools/live_probe.mjs <port> <browser>` drives the real
  extension in a throwaway profile. A change to either page has to keep both green.
- `python tools/package.py` builds the zip the store gets. It refuses to write one unless every entry
  matches this folder, so it is the last check before a release.
- Releasing is one command, from a clean tree: `python tools/release.py <version>`. It bumps the
  version, runs the suites, probes the real extension if you give it a port, packages the zip,
  writes the table row, publishes the release and delivers to the Desktop folder, stopping at the
  first thing that is not true. `RELEASING.md` has the details, including the two steps that need
  a store account and so stay manual.
- No new permissions, no network calls, and nothing that phones home. Those are the rules the
  extension is built on, and a pull request that breaks one will be turned down however good it is.
