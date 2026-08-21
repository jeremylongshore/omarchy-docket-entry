# Verification

Every claim below was produced by running the thing, on 2026-08-21, against the live GitHub API
from this build machine. Nothing here is recalled or assumed. Where something could not be
verified, it says so.

## Unit suite

```
$ node --test tests/*.test.js
# tests 81
# pass 81
# fail 0
```

81 tests, entirely offline, against captured response bodies in `tests/fixtures/`.

## Transport, measured not recited

The exact GraphQL document `Model.graphqlQuery()` builds, POSTed to `https://api.github.com/graphql`
with the credential over stdin:

| Page size | `rateLimit.cost` | Result |
| --- | --- | --- |
| `first: 25` | **1** | 88 review-requested, 112 authored |
| `first: 50` | **2** | 88 review-requested, 112 authored |

Docket ships `PAGE_SIZE = 50`, so a poll costs 2 points of a 5000-point hourly budget. At the
default 15-minute cadence that is 8 points an hour, 0.16 percent.

`issueCount` and `nodes.length` disagree (88 versus 50 at `first: 50`). Docket therefore computes
every count from the rows it actually holds and never renders `issueCount` as the docket size, so
the pill can never claim 88 over a list of 50.

**What that disagreement also means, and what changed because of it.** With 88 matches and one page
of 50, the sort decides which 38 are unreachable. The first build shipped `sort:updated-desc`, which
returns the *newest* page and makes the *oldest* obligations permanently unfetchable: never
rendered, never marked overdue, never counted in `counts().overdue`, on a widget whose entire claim
is "oldest obligation first". Both searches now use `sort:updated-asc`, and `issueCount` plus
`pageInfo.hasNextPage` are parsed and rendered as a truncation line (`172 newer not fetched` against
the captured fixture) rather than dropped. Pinned by unit tests that assert the ordering and reject
`updated-desc` outright.

The end-to-end capture below predates that change and was taken against `updated-desc`: its counts
are real, its ordering is the old one.

## End-to-end poll, real response through the real pipeline

Running the exact argv `Service.apiArgs()` builds, with the Authorization header written to stdin
exactly as `Process.onStarted` writes it:

```
status  200
parse   valid=true cost=2 reviewRequested=50 mine=50
queue   review=15 blocked=9 ready=0  total=24  overdue=20
pill    "20 overdue"
tooltip Docket: 15 to review, 9 blocked on you (20 overdue) checked 5m ago
head    review | ...#1144 | 22d | checks failing
        review | ...#1150 | 21d | checks failing
        review | ...#1103 | 21d | checks failing
```

Ordering is oldest first, as designed.

## The 502 is real, and it is handled

The first attempt at the above returned **HTTP 502** with an nginx HTML body rather than JSON.
`Model.parseSearch()` returned its zero object without throwing, and the pipeline produced an empty
docket and a `"api error"` code rather than a crash. This is the exact failure a JSON-assuming
parser dies on, and it happened on the first live attempt rather than in theory.

## Bot volume, measured on a real account

Building the queue from the same live response with bots hidden versus shown:

```
bots hidden removes 35 items
```

35 of 59 rows were dependency bots. Hiding them by default is not a preference, it is the
difference between a usable queue and a wall of `Bump x from 1.0 to 1.1`.

Bot detection reads `author.__typename == "Bot"`. String matching on the login is unreliable across
endpoints: search returns the bare `dependabot` while the reviews endpoint returns the bracketed
`greptile-apps[bot]`.

## Field distributions, from the live capture

Across 50 captured nodes:

- `reviewDecision`: `null` 30, `REVIEW_REQUIRED` 20. **`null` does not mean nobody weighed in.** It
  means the repository has no branch-protection review requirement. Docket falls back to
  `latestOpinionatedReviews` on null.
- `statusCheckRollup`: `SUCCESS` 23, `FAILURE` 18, **`null` 9**. A null rollup means the head commit
  has no checks at all. Docket renders it as "no checks" and it never satisfies the ready-to-merge
  test.
- `mergeable`: `MERGEABLE` 37, `CONFLICTING` 12, `UNKNOWN` 1. GitHub computes mergeability lazily,
  so `UNKNOWN` is never cached as fine.
- `author.__typename`: `Bot` 16, `User` 9 in the review-requested lane.
- `isDraft`: 9 of 25 of my own open pull requests were drafts.

## Why the server-side qualifiers were rejected

Measured on this account:

```
is:open is:pr author:@me review:changes_requested  -> total_count 0
is:open is:pr author:@me review:approved           -> total_count 0
is:open is:pr author:@me review:none               -> total_count 116
is:open is:pr author:@me                           -> total_count 112
```

The qualifiers work in general (a control against `repo:rust-lang/rust review:changes_requested`
returns 130) but they only reflect branch-protection-decided state, so on a repository without
required reviews everything collapses into `review:none`. An implementation built on
`author:@me review:changes_requested` ships a permanently empty widget that looks like it is
working. Docket classifies client side instead.

## `archived:false` is load bearing

Including it moved the review-requested count from 93 to 88 on this account. Those five were pull
requests in archived repositories that can never be acted on.

## Login helper, run for real

```
$ gh auth token | ./bin/docket-login
docket-login: connected as <login> (token ending <last4>). The widget picks it up within a minute.

$ stat -c '%a %n' ~/.local/state/omarchy/docket ~/.local/state/omarchy/docket/credentials.json
700 /home/.../omarchy/docket
600 /home/.../omarchy/docket/credentials.json

$ jq -r 'keys|join(",")' ~/.local/state/omarchy/docket/credentials.json
host,login,token
```

Only the last four characters of the token were printed. `shellcheck bin/docket-login` is clean.

## Static checks run here

```
$ bash -n bin/docket-login          # syntax ok
$ shellcheck bin/docket-login       # clean
$ python3 -c 'import json;json.load(open("manifest.json"))'   # valid
```

## QML statically linted on the Omarchy rig

`qmllint` ships in the rig image at `/usr/lib/qt6/bin/qmllint`. It is not on `PATH`, which is why an
earlier pass recorded it as absent.

```
$ docker exec omarchy-rig /usr/lib/qt6/bin/qmllint BarWidget.qml   exit=0 errors=0 warnings=27
$ docker exec omarchy-rig /usr/lib/qt6/bin/qmllint Panel.qml       exit=0 errors=0 warnings=127
$ docker exec omarchy-rig /usr/lib/qt6/bin/qmllint Service.qml     exit=0 errors=0 warnings=2
```

**0 errors across all three.** Every warning traces to `qs.Commons` / `qs.Ui` being unimportable on a
rig with no shell modules on the import path: 119 unqualified, 15 missing-property, 14 import,
5 unresolved-type, 2 signal-handler-parameters, 2 inheritance-cycle, 1 unused-imports. Static lint is
not a render: see "What could NOT be verified" below.

## Manifest validated on the Omarchy rig

The plugin directory was copied onto the rig and run through the first-party validator:

```
$ ssh intent-ops-buzz 'docker exec omarchy-rig /root/omarchy/bin/omarchy-plugin-validate /tmp/docket'
exit=0
```

That covers the required manifest fields, the id regex and reserved-namespace rule, the
kind-to-entryPoint pairing (`service` to `Service.qml`, `bar-widget` to `BarWidget.qml`), the
relative-and-existing entry point rule, and the no-symlinks rule.

`Model.js` is asserted ES5-clean by a unit test: no `let`, `const`, arrow function, `require()`, or
spread outside comments. A `let` passes `node --test` cleanly and only fails inside Quickshell's JS
engine at runtime, where it surfaces as an empty widget and one console line nobody reads.

A unit test also asserts that no em dash or en dash appears in any shipped file.

## Adversarial review pass, 2026-08-21

Four independent reviewers read the shipped tree. Two BLOCK findings and eleven FIX findings were
reproduced and repaired: the search ordering above; `docket-login` not being resolvable on a stock
install (Omarchy puts no plugin `bin/` on `PATH`, verified against `default/bash/env-bootstrap` on
the rig); a homoglyph marker that was inert for its own documented example; a consent prompt in
`docket-login` whose polarity was inverted and whose answer was then never read; `state.json`
carrying private repository names and pull request titles while `SECURITY.md` said otherwise; a
cursor anchored to an ordinal that a background poll could move under the user; presence-based
pruning that let one partial API response revert a drain; `403` conflated with an auth failure; and
`"checked just now ago"`. Each has a regression test. One finding was rejected on evidence:
`barWidget.defaultSection` is a real, validated field, read by
`/root/omarchy/shell/services/PluginRegistry.qml` and enforced by `omarchy-plugin-validate`, and two
first-party plugins ship it.

## What could NOT be verified here

- **The plugin has not been loaded into a running Omarchy shell.** The QML contracts (BarWidget
  shape, `serviceFor` retry, `KeyboardPanel` wiring, `PanelKeyCatcher` key routing, `manageIpc:
  false`, the IPC fan-out through `hostWidget.broadcast`) were copied from two sibling plugins
  already running on the rig, and `BarWidget.qml` is byte-identical to the proven sibling apart
  from `moduleName` and two comment blocks. That is provenance, not a rig run. The manifest itself
  WAS validated on the rig (above), but nothing rendered: no bar slot, no panel, no key press.
- **No notification has been fired.** `omarchy-notification-send` is not installed on this build
  machine, so the notification argv construction is verified by unit test and by identity with a
  shipped sibling, not by observing a toast.
- **No screenshot exists**, so `preview.png` is absent from this repository. It has to be captured
  from a running bar.
- **`reviewDecision: "CHANGES_REQUESTED"` and `"APPROVED"` were not present in the live capture.**
  Both were confirmed to exist by the recon pass against `rust-lang/rust`, and both are covered by
  the hand-built edge-case fixture, but neither appeared in the scrubbed real capture.
- **SAML SSO orgs were not exercised.** A `repo`-scoped token still returns 403 for an org
  enforcing SSO until explicitly authorized, and that partial-inbox case is untested here.
