# Marketplace contract

Docket ships one bar widget and one service whose listing copy and runtime
behavior tell the same product story.

- Root and bar-widget descriptions are identical and exactly 500 characters.
- Copy names all three obligation lanes, oldest-first ordering, configurable
  overdue marking, row draining and reappearance, and the 15-minute poll.
- `assets/banner.svg` identifies Docket and depicts the pull-request queue.
- `preview.png` is accepted only with current-tree Buzz provenance, exact
  1280x720 dimensions, a clean shell-log hash, and visual approval.
- The service performs one bounded GitHub GraphQL poll per interval. Credentials
  remain local and never enter process arguments.

`tests/contract.test.js`, credential-helper tests, and gate C43 enforce the
machine-checkable portions.
