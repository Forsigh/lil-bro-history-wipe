# Contributing

Issues are welcome, and so are fixes.

- Small pull requests. One change each, and say in the description what you tested it with.
- `npm test` runs all six suites. `node tools/live_probe.mjs <port> <browser>` drives the real
  extension in a throwaway profile. A change to either page has to keep both green.
- Wording counts as much as code here. If a line reads like a machine wrote it, that is a bug, and
  an issue about it is a real issue.
- No new permissions, no network calls, and nothing that phones home. Those are the rules the
  extension is built on, and a pull request that breaks one will be turned down however good it is.
