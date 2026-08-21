# Fixtures

Every test in `tests/model.test.js` runs against captured bytes on disk. Nothing in the suite
touches the network, and the suite is the only place node appears in this project at all.

## What is here

| File | Origin |
| --- | --- |
| `search-live-scrubbed.json` | A **real** GitHub GraphQL response, captured 2026-08-21 with the exact document `Model.graphqlQuery()` builds. Trimmed to 14 nodes per search field, then scrubbed. |
| `search-edge-cases.json` | Hand built in the same shape, covering the states the live capture happened not to contain. |
| `graphql-errors.json` | A GraphQL errors envelope. |
| `nginx-502.html` | The nginx 502 page GraphQL occasionally returns instead of JSON. |

## What "scrubbed" means

Replaced with deterministic neutral placeholders: every repository `nameWithOwner`, every author
`login`, every `title`, and every pull request `number`. The `url` field is **removed** entirely,
because Docket rebuilds every URL from the repository and number and must never read that field.

Left untouched, because they are what the tests are about: `reviewDecision`, `mergeable`,
`statusCheckRollup.state`, `author.__typename`, `isDraft`, `isCrossRepository`,
`repository.isPrivate`, `latestOpinionatedReviews`, `createdAt`, `updatedAt`, `issueCount`,
`pageInfo`, and `rateLimit`.

No token, and no real identity, is present in any fixture.

## Recapture

```bash
node -e 'process.stdout.write(require("./Model.js").graphqlBody(25))' > /dev/shm/body.json

TOK=$(jq -r .token "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/docket/credentials.json")
printf 'Authorization: Bearer %s\n' "$TOK" | curl -sS \
  --proto '=https' --max-time 20 --max-filesize 2000000 \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: docket/1.0 (Omarchy bar widget)' \
  --header @- -d @/dev/shm/body.json \
  -- https://api.github.com/graphql > /dev/shm/raw.json

rm -f /dev/shm/body.json
```

Decrypt or read a token only into `/dev/shm`, never to a path on disk, and remove the request body
afterwards.

Then scrub. The rules are the table above; the aliasing must be deterministic so a recapture does
not churn the whole file. Trim to roughly 14 nodes per field to keep the fixture small, verify with
`grep` that no real login or repository name survives, and re-run `node --test tests/*.test.js`.

## Deterministic clock

The suite pins `NOW_MS = Date.parse("2026-08-21T14:00:00Z")`. Every age, overdue, and pill
assertion is computed against that constant, so a recapture with newer timestamps may shift which
rows count as overdue. Adjust the assertions that count overdue rows, never the pinned clock.
