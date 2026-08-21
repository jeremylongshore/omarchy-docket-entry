const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const Model = require("../Model.js")

// Fixtures. search-live-scrubbed.json is a REAL GitHub GraphQL response
// captured 2026-08-21 with the exact document Model.graphqlQuery() builds,
// trimmed to 14 nodes per field and scrubbed: every repository, login, title,
// and PR number replaced with a neutral placeholder. Every structural field
// (reviewDecision, mergeable, statusCheckRollup, __typename, isDraft,
// isCrossRepository, isPrivate, timestamps) is untouched real data.
// search-edge-cases.json is hand-built in the same shape to cover the states
// the live capture happened not to contain. Recapture: docs/FIXTURES.md.
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")

const LIVE = fixture("search-live-scrubbed.json")
const EDGE = fixture("search-edge-cases.json")

// Pinned so every age and overdue assertion is deterministic.
const NOW_MS = Date.parse("2026-08-21T14:00:00Z")

const byNumber = (queue, n) => queue.find((it) => it.number === n)

// ---------------------------------------------------------------- clean --

test("clean strips angle brackets so AutoText can never promote to StyledText", () => {
  assert.equal(Model.clean('<img src="http://x/y.png">ok'), 'img src="http://x/y.png"ok')
})

test("clean strips ASCII controls, bidi overrides, and Unicode tag characters", () => {
  assert.equal(Model.clean("a\x00b\x1bc\x7fd"), "abcd")
  assert.equal(Model.clean("a‮b​c⁦d"), "abcd")
  assert.equal(Model.clean("a\u{E0041}b"), "ab")
})

test("clean caps length and tolerates null and undefined", () => {
  assert.equal(Model.clean("x".repeat(500), 64).length, 64)
  assert.equal(Model.clean(null), "")
  assert.equal(Model.clean(undefined), "")
})

test("isSpoofy flags a name carrying a bidi override", () => {
  assert.equal(Model.isSpoofy("acme/gateway"), false)
  assert.equal(Model.isSpoofy("acme/gate\u202eway"), true)
})

// ------------------------------------------------------------------ url --

test("prUrl rebuilds from stripped pieces and rejects anything it cannot", () => {
  assert.equal(Model.prUrl("acme/gateway", 42), "https://github.com/acme/gateway/pull/42")
  assert.equal(Model.prUrl("acme/gate way", 42), "https://github.com/acme/gateway/pull/42")
  assert.equal(Model.prUrl("acme", 42), "")
  assert.equal(Model.prUrl("acme/gateway", "abc"), "")
  assert.equal(Model.prUrl("", 42), "")
})

test("prUrl output always satisfies the exec-safe charset", () => {
  assert.ok(Model.isSafePrUrl(Model.prUrl("acme/gate-way_1.0", 7)))
})

test("the exec-safe pattern rejects every shell metacharacter", () => {
  const hostile = [
    "https://github.com/a/b/pull/1;id",
    "https://github.com/a/b/pull/1'",
    "https://github.com/a/b/pull/1 $(id)",
    "https://github.com/a/b/pull/1`id`",
    "https://github.com/a/b/pull/1&whoami",
    "http://github.com/a/b/pull/1",
    "https://evil.example/a/b/pull/1",
  ]
  for (const u of hostile) assert.equal(Model.isSafePrUrl(u), false, u)
})

// -------------------------------------------------------------- request --

test("graphqlQuery asks both inboxes in one document with archived:false", () => {
  const q = Model.graphqlQuery(50)
  assert.match(q, /reviewRequested: search\(type: ISSUE, first: 50/)
  assert.match(q, /mine: search\(type: ISSUE, first: 50/)
  assert.equal((q.match(/archived:false/g) || []).length, 2)
  assert.match(q, /review-requested:@me/)
  assert.match(q, /author:@me/)
  // The classifier depends on every one of these being selected.
  for (const f of ["reviewDecision", "mergeable", "statusCheckRollup",
                   "latestOpinionatedReviews", "__typename", "isDraft",
                   "isCrossRepository", "nameWithOwner"]) {
    assert.ok(q.includes(f), "missing selection " + f)
  }
})

test("graphqlQuery never asks for a server-side review: or status: qualifier", () => {
  // Both are lossy: they only reflect branch-protection-decided state, so on a
  // repo without required reviews they collapse to review:none and the widget
  // ships permanently empty while looking healthy.
  const q = Model.graphqlQuery()
  assert.equal(/\breview:[a-z_]/.test(q), false)
  assert.equal(/\bstatus:[a-z_]/.test(q), false)
})

test("graphqlBody is valid JSON carrying the query", () => {
  const parsed = JSON.parse(Model.graphqlBody(25))
  assert.equal(typeof parsed.query, "string")
  assert.match(parsed.query, /first: 25/)
})

// ---------------------------------------------------------------- parse --

test("parseSearch reads the real captured response", () => {
  const p = Model.parseSearch(LIVE)
  assert.equal(p.valid, true)
  assert.equal(p.error, "")
  assert.equal(p.cost, 1)
  assert.equal(p.reviewRequested.length, 14)
  assert.equal(p.mine.length, 14)
})

test("parseSearch returns the zero object on an nginx 502 HTML body", () => {
  const p = Model.parseSearch(fixture("nginx-502.html"))
  assert.equal(p.valid, false)
  assert.deepEqual(p.reviewRequested, [])
})

test("parseSearch returns the zero object on a GraphQL errors envelope", () => {
  const p = Model.parseSearch(fixture("graphql-errors.json"))
  assert.equal(p.valid, false)
  assert.ok(Model.isAllowedError(p.error))
})

test("parseSearch refuses a body over the byte bound before JSON.parse", () => {
  const huge = "[" + "0,".repeat(Model.MAX_BODY_CHARS) + "0]"
  assert.ok(huge.length > Model.MAX_BODY_CHARS)
  assert.equal(Model.parseSearch(huge).valid, false)
})

test("parseSearch tolerates empty, null, and undefined input", () => {
  for (const v of ["", null, undefined, "{}", "null", "[]"]) {
    assert.equal(Model.parseSearch(v).valid, false)
  }
})

test("normalizeNode drops a node with no repository and one with no number", () => {
  assert.equal(Model.normalizeNode({ number: 1 }, "review"), null)
  assert.equal(Model.normalizeNode({ repository: { nameWithOwner: "a/b" } }, "review"), null)
  assert.equal(Model.normalizeNode(null, "review"), null)
})

test("parse drops the structurally broken nodes rather than throwing", () => {
  const p = Model.parseSearch(EDGE)
  // 206 has no repository at all; 207 has a null author but is otherwise valid.
  assert.equal(byNumber(p.reviewRequested, 206), undefined)
  assert.equal(byNumber(p.reviewRequested, 207).author, "")
})

test("a title carrying markup, a bidi override, and a tag char is sanitized at parse time", () => {
  const it = byNumber(Model.parseSearch(EDGE).reviewRequested, 203)
  assert.equal(/[<>]/.test(it.title), false)
  assert.equal(/[​-‏‪-‮⁦-⁩]/.test(it.title), false)
  assert.equal(/[\u{E0000}-\u{E007F}]/u.test(it.title), false)
})

test("the PR url is rebuilt from repo and number, never read from the response", () => {
  const raw = JSON.parse(EDGE)
  assert.equal("url" in raw.data.reviewRequested.nodes[0], false)
  const it = byNumber(Model.parseSearch(EDGE).reviewRequested, 201)
  assert.equal(it.url, "https://github.com/acme/gateway/pull/201")
})

test("a fork PR is attributed to its base repository and flagged", () => {
  const it = byNumber(Model.parseSearch(EDGE).reviewRequested, 204)
  assert.equal(it.repo, "northwind/ledger")
  assert.equal(it.isFork, true)
  assert.equal(it.isPrivate, true)
})

// ----------------------------------------------------------- field reads --

test("rollupState treats a null rollup as 'none', never as green", () => {
  assert.equal(Model.rollupState({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), "none")
  assert.equal(Model.rollupState({ commits: { nodes: [] } }), "none")
  assert.equal(Model.rollupState({}), "none")
})

test("rollupState maps FAILURE and ERROR to red and PENDING to pending", () => {
  const roll = (s) => Model.rollupState({ commits: { nodes: [{ commit: { statusCheckRollup: { state: s } } }] } })
  assert.equal(roll("FAILURE"), "red")
  assert.equal(roll("ERROR"), "red")
  assert.equal(roll("SUCCESS"), "green")
  assert.equal(roll("PENDING"), "pending")
})

test("effectiveDecision falls back to per-reviewer verdicts when the decision is null", () => {
  // reviewDecision is null on a repo with no required-review rule (30 of 50
  // measured live nodes), which is NOT the same as nobody having weighed in.
  assert.equal(Model.effectiveDecision({ reviewDecision: null,
    latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }] } }),
    "CHANGES_REQUESTED")
  assert.equal(Model.effectiveDecision({ reviewDecision: null,
    latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] } }), "APPROVED")
  assert.equal(Model.effectiveDecision({ reviewDecision: null,
    latestOpinionatedReviews: { nodes: [] } }), "")
  assert.equal(Model.effectiveDecision({ reviewDecision: "APPROVED" }), "APPROVED")
})

test("mergeState collapses anything that is not MERGEABLE or CONFLICTING to UNKNOWN", () => {
  assert.equal(Model.mergeState({ mergeable: "UNKNOWN" }), "UNKNOWN")
  assert.equal(Model.mergeState({}), "UNKNOWN")
  assert.equal(Model.mergeState({ mergeable: "CONFLICTING" }), "CONFLICTING")
})

// ------------------------------------------------------------- classify --

test("classifyMine puts changes-requested, conflicting, and red-CI PRs in the blocked lane", () => {
  const p = Model.parseSearch(EDGE)
  assert.equal(Model.classifyMine(byNumber(p.mine, 301)), "blocked")
  assert.equal(Model.classifyMine(byNumber(p.mine, 302)), "blocked")
  assert.equal(Model.classifyMine(byNumber(p.mine, 303)), "blocked")
})

test("classifyMine promotes only approved AND green AND mergeable to ready", () => {
  const p = Model.parseSearch(EDGE)
  assert.equal(Model.classifyMine(byNumber(p.mine, 304)), "ready")
  // Approved and mergeable but no checks at all: a null rollup is not green.
  assert.equal(Model.classifyMine(byNumber(p.mine, 305)), "")
  // Approved and green but mergeability is still UNKNOWN: never cached as fine.
  assert.equal(Model.classifyMine(byNumber(p.mine, 306)), "")
})

test("classifyMine leaves a PR that is waiting on a reviewer off the docket", () => {
  assert.equal(Model.classifyMine(byNumber(Model.parseSearch(EDGE).mine, 307)), "")
})

test("classifyMine never puts a draft on the docket", () => {
  assert.equal(Model.classifyMine(byNumber(Model.parseSearch(EDGE).mine, 308)), "")
})

test("a blocked PR carries a human reason", () => {
  const it = byNumber(Model.parseSearch(EDGE).mine, 301)
  Model.classifyMine(it)
  assert.equal(it.reason, "changes requested")
})

// ---------------------------------------------------------------- queue --

test("buildQueue hides bot-authored PRs by default and shows them on request", () => {
  const p = Model.parseSearch(EDGE)
  assert.equal(byNumber(Model.buildQueue(p, {}), 202), undefined)
  const shown = Model.buildQueue(Model.parseSearch(EDGE), { botPullRequests: "Show" })
  assert.ok(byNumber(shown, 202))
})

test("bot detection reads __typename, not the login string", () => {
  const p = Model.parseSearch(EDGE)
  const bot = p.reviewRequested.find((it) => it.isBot)
  assert.ok(bot)
  // The login is the bare form; a 'dependabot[bot]' substring match would miss it.
  assert.equal(/\[bot\]$/.test(bot.author), false)
})

test("buildQueue drops a draft review request and your own drafts by default", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  assert.equal(byNumber(q, 205), undefined)
  assert.equal(byNumber(q, 308), undefined)
})

test("myDrafts Show surfaces your own drafts as blocked on you", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), { myDrafts: "Show" })
  const d = byNumber(q, 308)
  assert.equal(d.lane, "blocked")
  assert.equal(d.reason, "draft")
})

test("buildQueue orders the docket oldest obligation first", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1].updatedMs <= q[i].updatedMs)
})

test("buildQueue is bounded by MAX_QUEUE", () => {
  const p = Model.parseSearch(LIVE)
  const many = { valid: true, error: "", cost: 1, reviewRequested: [], mine: [] }
  for (let i = 0; i < 40; i++) many.reviewRequested = many.reviewRequested.concat(
    p.reviewRequested.map((it) => Object.assign({}, it, { guid: it.guid + "-" + i })))
  assert.ok(many.reviewRequested.length > Model.MAX_QUEUE)
  assert.equal(Model.buildQueue(many, {}).length, Model.MAX_QUEUE)
})

test("buildQueue over the real captured response produces a usable docket", () => {
  const q = Model.buildQueue(Model.parseSearch(LIVE), {})
  assert.ok(q.length > 0)
  for (const it of q) {
    assert.ok(["review", "blocked", "ready"].includes(it.lane))
    assert.ok(Model.isSafePrUrl(it.url))
    assert.ok(it.title.length <= Model.MAX_TITLE_CHARS)
  }
})

test("laneRows filters by lane and respects its cap", () => {
  const q = Model.buildQueue(Model.parseSearch(LIVE), {})
  const rows = Model.laneRows(q, "review", 3)
  assert.ok(rows.length <= 3)
  for (const r of rows) assert.equal(r.lane, "review")
})

// -------------------------------------------------------------- draining --

test("a drain is bound to updatedAt so a changed PR comes back", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const it = q[0]
  const drained = {}
  drained[Model.stampOf(it)] = true
  assert.equal(Model.applyDrained(q, drained).length, q.length - 1)
  // Same pull request, new activity: a new stamp, so it is back on the docket.
  const moved = Object.assign({}, it, { updatedMs: it.updatedMs + 60000 })
  assert.equal(Model.isDrained(drained, moved), false)
})

test("pruneDrained keeps a live stamp and re-stamps a legacy true", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const drained = { "gone/repo#1@123": NOW_MS - 8 * 24 * 3600000 }
  drained[Model.stampOf(q[0])] = true   // legacy record shape
  const pruned = Model.pruneDrained(drained, q, NOW_MS)
  assert.equal(pruned["gone/repo#1@123"], undefined, "8 days absent is dropped")
  assert.equal(pruned[Model.stampOf(q[0])], NOW_MS, "legacy true is re-stamped")
})

test("pruneDrained does NOT delete a drain that is merely absent this poll", () => {
  // The regression: presence-based pruning treated one transient shrink of the
  // result set as "gone forever", so a partial GraphQL envelope or a MAX_QUEUE
  // cut reverted the user's mark-done and the row re-notified on the next
  // healthy poll. A keystroke must never be undone by a poll.
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const stamp = Model.stampOf(q[0])
  const drained = {}
  drained[stamp] = NOW_MS
  const survives = Model.pruneDrained(drained, [], NOW_MS + 3600000)
  assert.equal(survives[stamp], NOW_MS, "absent for an hour still survives")
  const expired = Model.pruneDrained(drained, [], NOW_MS + Model.STAMP_RETENTION_MS + 1)
  assert.equal(expired[stamp], undefined, "absent past the retention bound is dropped")
})

// ---------------------------------------------------------------- clock --

test("clampSla floors, ceilings, and falls back on nonsense", () => {
  assert.equal(Model.clampSla(0), Model.DEFAULT_SLA_HOURS)
  assert.equal(Model.clampSla(-5), Model.DEFAULT_SLA_HOURS)
  assert.equal(Model.clampSla("banana"), Model.DEFAULT_SLA_HOURS)
  assert.equal(Model.clampSla(100000), Model.MAX_SLA_HOURS)
  assert.equal(Model.clampSla(0.4), Model.MIN_SLA_HOURS)
  assert.equal(Model.clampSla(48), 48)
})

test("isOverdue measures from updatedAt against the clamped clock", () => {
  const it = { updatedMs: NOW_MS - 25 * 3600000 }
  assert.equal(Model.isOverdue(it, 24, NOW_MS), true)
  assert.equal(Model.isOverdue(it, 48, NOW_MS), false)
  assert.equal(Model.isOverdue({ updatedMs: 0 }, 24, NOW_MS), false)
})

test("ageText renders minutes, hours, and days without a clock call", () => {
  assert.equal(Model.ageText(NOW_MS - 30000, NOW_MS), "just now")
  assert.equal(Model.ageText(NOW_MS - 5 * 60000, NOW_MS), "5m")
  assert.equal(Model.ageText(NOW_MS - 5 * 3600000, NOW_MS), "5h")
  assert.equal(Model.ageText(NOW_MS - 72 * 3600000, NOW_MS), "3d")
  assert.equal(Model.ageText(0, NOW_MS), "")
})

// ----------------------------------------------------------------- pill --

test("the pill collapses to empty on a drained docket and never shows a zero", () => {
  assert.equal(Model.pillText(Model.counts([], 24, NOW_MS)), "")
  assert.equal(Model.pillText(null), "")
  assert.equal(Model.pillText({ total: 0, review: 0, blocked: 0, ready: 0, overdue: 0 }), "")
})

test("the pill names the single-lane case and generalizes on a mixed docket", () => {
  const c = (o) => Object.assign({ review: 0, blocked: 0, ready: 0, overdue: 0, total: 0 }, o)
  assert.equal(Model.pillText(c({ review: 3, total: 3 })), "3 to review")
  assert.equal(Model.pillText(c({ blocked: 2, total: 2 })), "2 blocked")
  assert.equal(Model.pillText(c({ ready: 1, total: 1 })), "1 to merge")
  assert.equal(Model.pillText(c({ review: 2, ready: 1, total: 3 })), "3 on your docket")
})

test("overdue outranks every other pill state", () => {
  assert.equal(Model.pillText({ review: 5, blocked: 0, ready: 0, total: 5, overdue: 2 }), "2 overdue")
})

test("a missing token renders a distinct setup pill, not an empty docket", () => {
  assert.equal(Model.setupPillText(false), "Docket: connect")
  assert.equal(Model.setupPillText(true), "")
  assert.match(Model.tooltipText(null, false, 0, NOW_MS, ""), /docket-login/)
  assert.equal(Model.tooltipText({ total: 0 }, true, 0, NOW_MS, ""), "Docket: clear")
})

test("the tooltip names each lane and the check age", () => {
  const t = Model.tooltipText({ review: 2, blocked: 1, ready: 0, total: 3, overdue: 1 },
    true, NOW_MS - 5 * 60000, NOW_MS, "")
  assert.match(t, /2 to review/)
  assert.match(t, /1 blocked on you/)
  assert.match(t, /1 overdue/)
  assert.match(t, /checked 5m ago/)
})

test("counts reports lanes, overdue, and the oldest obligation", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const c = Model.counts(q, 24, NOW_MS)
  // Independently computed, not restated from how counts() builds total.
  assert.equal(c.total, q.length)
  assert.equal(c.review, q.filter((it) => it.lane === "review").length)
  assert.equal(c.blocked, q.filter((it) => it.lane === "blocked").length)
  assert.equal(c.ready, q.filter((it) => it.lane === "ready").length)
  assert.equal(c.overdue,
    q.filter((it) => (NOW_MS - it.updatedMs) / 3600000 >= 24).length)
  assert.ok(c.overdue >= 1)
  assert.equal(c.oldestMs, Math.min(...q.map((it) => it.updatedMs)))
})

test("counts finds the oldest even when one row has an unparseable timestamp", () => {
  // The old guard was `c.oldestMs === 0 || (it.updatedMs > 0 && ...)`, so one
  // item whose createdAt/updatedAt failed Date.parse pinned oldestMs at 0
  // forever and let every later row overwrite oldestRepo. The reported
  // "oldest" was then the LAST row in the queue.
  const q = [
    { lane: "review", updatedMs: 0, repo: "zzz/broken" },
    { lane: "review", updatedMs: NOW_MS - 5 * 3600000, repo: "acme/oldest" },
    { lane: "review", updatedMs: NOW_MS - 1 * 3600000, repo: "acme/newest" },
  ]
  const c = Model.counts(q, 24, NOW_MS)
  assert.equal(c.oldestRepo, "acme/oldest")
  assert.equal(c.oldestMs, NOW_MS - 5 * 3600000)
})

// ---------------------------------------------------------------- error --

test("every error code the poller can produce is in the allowed set", () => {
  for (const code of [0, 200, 401, 403, 429, 500, 502]) {
    assert.ok(Model.isAllowedError(Model.httpErrorCode(code)), "code " + code)
  }
  assert.equal(Model.httpErrorCode(200), "")
  assert.equal(Model.httpErrorCode(401), "not connected")
  // 403 is GitHub's primary AND secondary rate-limit answer, not only an auth
  // failure. Mapping it to "not connected" sent a throttled user to re-mint a
  // token, which does not help and produces the same string afterwards.
  assert.equal(Model.httpErrorCode(403), "rate limited")
  assert.equal(Model.httpErrorCode(429), "rate limited")
  assert.equal(Model.httpErrorCode(0), "fetch failed")
  assert.equal(Model.httpErrorCode(502), "api error")
})

test("no allowed error code can carry captured output", () => {
  // The regression this pins: 'let me surface the real curl error' is the most
  // natural-looking change that puts a token or a private repo name into a
  // file a user will paste into a bug report. Asserting the set against an
  // independently written expected list, NOT against a regex spelling out the
  // same five strings, which would have been a tautology.
  assert.deepEqual(Model.ERROR_CODES.slice().sort(),
    ["", "api error", "fetch failed", "not connected", "rate limited"])
  assert.equal(Model.isAllowedError("curl: (60) SSL certificate problem"), false)
  assert.equal(Model.isAllowedError("Authorization: Bearer ghp_xxx"), false)
  assert.equal(Model.isAllowedError("rate limited "), false)
})

// --------------------------------------------------------- notifications --

test("the first run notifies nothing because history is not news", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const notified = {}
  for (const it of q) notified[it.guid] = true
  assert.equal(Model.newNotifiables(q, notified).length, 0)
})

test("only items new to the docket are notifiable", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const notified = {}
  notified[q[0].guid] = true
  assert.equal(Model.newNotifiables(q, notified).length, q.length - 1)
})

test("pruneNotified drops ids absent past the retention bound, not merely absent", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const notified = { "gone/repo#9": NOW_MS - 8 * 24 * 3600000 }
  notified[q[0].guid] = NOW_MS - 3600000
  const pruned = Model.pruneNotified(notified, q, NOW_MS)
  assert.equal(pruned["gone/repo#9"], undefined)
  assert.equal(pruned[q[0].guid], NOW_MS, "still live, so re-stamped")
  // A poll that returned an empty docket must not clear the notified set, or
  // every row re-notifies on the next healthy poll.
  const kept = Model.pruneNotified(notified, [], NOW_MS)
  assert.equal(kept[q[0].guid], NOW_MS - 3600000)
})

test("notification text is sanitized and bounded", () => {
  const it = byNumber(Model.parseSearch(EDGE).reviewRequested, 203)
  it.lane = "review"
  const body = Model.notificationBody(it)
  assert.equal(/[<>]/.test(body), false)
  assert.ok(body.length <= 180)
  assert.match(Model.notificationHeadline(it), /needs your review/)
})

// ---------------------------------------------------------------- state --

test("parseState returns the zero record on anything malformed", () => {
  for (const v of ["", "null", "{}", "not json", '{"queue":"nope"}', null, undefined]) {
    assert.equal(Model.parseState(v).valid, false)
  }
})

test("parseState refuses an oversized record before JSON.parse", () => {
  assert.equal(Model.parseState("x".repeat(Model.MAX_BODY_CHARS + 1)).valid, false)
})

test("a round trip through the state record preserves the docket", () => {
  const q = Model.buildQueue(Model.parseSearch(EDGE), {})
  const raw = JSON.stringify({ generatedAt: NOW_MS, configured: true, queue: q,
    lastError: "", account: { login: "rlee", last4: "abcd" } })
  const back = Model.parseState(raw)
  assert.equal(back.valid, true)
  assert.equal(back.queue.length, q.length)
  assert.equal(back.queue[0].guid, q[0].guid)
  assert.equal(back.account.last4, "abcd")
})

test("parseState truncates an account field that carries more than a last4", () => {
  const raw = JSON.stringify({ configured: true, queue: [],
    account: { login: "rlee", last4: "ghp_thisisawholetoken" } })
  assert.equal(Model.parseState(raw).account.last4.length, 4)
})

test("parseState scrubs a disallowed lastError rather than rendering it", () => {
  const raw = JSON.stringify({ configured: true, queue: [],
    lastError: "curl failed: Authorization: Bearer ghp_leak" })
  assert.equal(Model.parseState(raw).lastError, "")
})

test("parseState re-derives every url and drops a row whose repo cannot build one", () => {
  const raw = JSON.stringify({ configured: true, queue: [
    { guid: "a/b#1", repo: "a/b", number: 1, url: "javascript:alert(1)", lane: "review" },
    { guid: "bad#2", repo: "bad", number: 2, lane: "review" },
  ] })
  const back = Model.parseState(raw)
  assert.equal(back.queue.length, 1)
  assert.equal(back.queue[0].url, "https://github.com/a/b/pull/1")
})

test("parseState is bounded by MAX_QUEUE", () => {
  const rows = []
  for (let i = 0; i < Model.MAX_QUEUE + 50; i++) {
    rows.push({ guid: "a/b#" + i, repo: "a/b", number: i + 1, lane: "review" })
  }
  assert.equal(Model.parseState(JSON.stringify({ queue: rows })).queue.length, Model.MAX_QUEUE)
})

test("parseInternal recovers a partial or broken bookkeeping record", () => {
  assert.deepEqual(Model.parseInternal(""), Model.emptyInternal())
  assert.deepEqual(Model.parseInternal("garbage"), Model.emptyInternal())
  const partial = Model.parseInternal(JSON.stringify({ firstRun: false }))
  assert.equal(partial.firstRun, false)
  assert.deepEqual(partial.drained, {})
})

// -------------------------------------------------- pagination / ordering --
//
// These pin the defect class that shipped green under 64 passing tests: nothing
// asserted anything about which page GitHub returns, so a page that silently
// dropped every old obligation was invisible to the suite.

test("both searches ask for the OLDEST page, never the newest", () => {
  const q = Model.graphqlQuery(50)
  // The whole product claim is "oldest obligation first". With more matches
  // than PAGE_SIZE, GitHub returns one page and drops the rest, so the sort
  // decides which results are reachable at all. updated-desc returns the newest
  // and makes the oldest permanently unfetchable: never rendered, never marked
  // overdue, never counted in counts().overdue, while the pill reads a small
  // number over a large backlog.
  assert.equal((q.match(/sort:updated-asc/g) || []).length, 2)
  assert.equal(/sort:updated-desc/.test(q), false, "updated-desc buries the docket")
})

test("the query selects the pagination fields the truncation line needs", () => {
  const q = Model.graphqlQuery(50)
  assert.match(q, /issueCount/)
  assert.match(q, /pageInfo \{ hasNextPage \}/)
})

test("parseSearch surfaces issueCount and hasNextPage per field", () => {
  const p = Model.parseSearch(LIVE)
  assert.equal(p.reviewTotal, 88)
  assert.equal(p.reviewFetched, 14)
  assert.equal(p.reviewTruncated, true)
  assert.equal(p.mineTotal, 112)
  assert.equal(p.mineTruncated, true)
})

test("fetchNoticeText renders the shortfall instead of hiding it", () => {
  // 88 - 14 plus 112 - 14. The number itself matters less than the fact that a
  // truncated page can never be presented as the whole docket.
  assert.equal(Model.fetchNoticeText(Model.parseSearch(LIVE)), "172 newer not fetched")
  assert.equal(Model.fetchNoticeText(Model.emptyParse()), "")
  assert.equal(Model.fetchNoticeText({ valid: true, reviewTruncated: false,
    mineTruncated: false }), "", "a complete page says nothing")
})

test("parseSearch REJECTS a partial envelope rather than reading a null lane as empty", () => {
  // GitHub answers 200 with one search field null and an errors array beside
  // it on a routine SERVICE_UNAVAILABLE. Accepting that as valid presented an
  // absent lane as an EMPTY lane, which then drove the prune passes to erase
  // every drain and every notified id belonging to it.
  const partial = JSON.stringify({
    data: { reviewRequested: null, mine: JSON.parse(LIVE).data.mine },
    errors: [{ type: "SERVICE_UNAVAILABLE" }],
  })
  assert.equal(Model.parseSearch(partial).valid, false)
  const other = JSON.stringify({ data: { reviewRequested: JSON.parse(LIVE).data.reviewRequested, mine: null } })
  assert.equal(Model.parseSearch(other).valid, false)
})

test("buildQueue dedupes a pull request that appears in BOTH searches", () => {
  // Your own pull request with your review requested on it comes back in both
  // fields. It must occupy one row, in the review lane, once.
  const node = JSON.parse(LIVE).data.reviewRequested.nodes[0]
  const both = JSON.stringify({ data: {
    reviewRequested: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [node] },
    mine: { issueCount: 1, pageInfo: { hasNextPage: false },
      nodes: [JSON.parse(JSON.stringify(node))] },
  } })
  const q = Model.buildQueue(Model.parseSearch(both), { botPullRequests: "Show" })
  const guid = q[0].guid
  assert.equal(q.filter((it) => it.guid === guid).length, 1)
  assert.equal(q[0].lane, "review")
})

// ------------------------------------------------------------- homoglyphs --

test("isSpoofy flags a Cyrillic lookalike, which clean() does not touch", () => {
  // The exact example SECURITY.md documents. The old test derived the answer
  // from clean(), which strips no homoglyphs at all, so it answered false while
  // prUrl silently linked to a DIFFERENT, registerable namespace.
  // \u0441 is CYRILLIC SMALL LETTER ES, a pixel-perfect lookalike for ASCII c.
  const spoof = "mi\u0441rosoft/vscode"
  assert.equal(Model.clean(spoof, 400), spoof, "clean() is a no-op here, by design")
  assert.equal(Model.isSpoofy(spoof), true)
  assert.equal(Model.prUrl(spoof, 1), "https://github.com/mirosoft/vscode/pull/1")
})

test("a spoofy name is marked on the row the panel renders", () => {
  const node = { number: 1, title: "t", author: { login: "a", __typename: "User" },
    repository: { nameWithOwner: "mi\u0441rosoft/vscode", isPrivate: false } }
  const it = Model.normalizeNode(node, "review")
  assert.equal(it.repoSpoofy, true)
  // Display and destination genuinely differ. That divergence IS the marker's
  // trigger, so the two can never drift apart again.
  assert.notEqual("https://github.com/" + it.repo + "/pull/1", it.url)
})

test("isSpoofy is quiet on ordinary names and loud on any link divergence", () => {
  assert.equal(Model.isSpoofy("acme/gate-way_1.0"), false)
  assert.equal(Model.isSpoofy(""), false)
  assert.equal(Model.isSpoofy("acme/gate way"), true)   // space is dropped by prUrl
  assert.equal(Model.isSpoofy("acme"), true)            // cannot build a link at all
  assert.equal(Model.isSpoofy("acme/gate\u202eway"), true)
})

// ---------------------------------------------------- sanitizer omissions --

test("clean strips the separator, joiner, and mark codepoints too", () => {
  for (const cp of ["\u2028", "\u2029", "\u061c", "\u2060", "\ufeff", "\u180e"]) {
    assert.equal(Model.clean("a" + cp + "b", 120), "ab", "kept " + cp.codePointAt(0).toString(16))
  }
})

test("clean never emits a lone surrogate when the cap lands mid pair", () => {
  const out = Model.clean("\u{1F600}".repeat(80), 5)
  const last = out.charCodeAt(out.length - 1)
  assert.equal(last >= 0xd800 && last <= 0xdbff, false, "lone high surrogate survived")
  assert.equal(out, "\u{1F600}\u{1F600}")
})

// ------------------------------------------------------------- phrasing --

test("checkedText never produces 'checked just now ago'", () => {
  assert.equal(Model.checkedText(NOW_MS, NOW_MS), "checked just now")
  assert.equal(Model.checkedText(NOW_MS - 5 * 60000, NOW_MS), "checked 5m ago")
  assert.equal(Model.checkedText(0, NOW_MS), "")
  assert.equal(/just now ago/.test(Model.tooltipText(
    { review: 1, blocked: 0, ready: 0, total: 1, overdue: 0 }, true, NOW_MS, NOW_MS, "")), false)
})

test("a null author does not produce '@ needs your review'", () => {
  const it = Model.normalizeNode({ number: 4, title: "t", author: null,
    repository: { nameWithOwner: "acme/gateway", isPrivate: false } }, "review")
  assert.equal(it.author, "")
  assert.equal(Model.notificationHeadline(it), "A pull request needs your review")
  assert.equal(Model.notificationHeadline({ lane: "review", author: "rlee" }),
    "@rlee needs your review")
})

// ---------------------------------------------- the persisted record shape --

test("the record the service writes carries counts and NO item rows", () => {
  // state.json is world readable in practice: the only thing that ever reads it
  // is a human pasting it into a bug report. It used to carry the whole queue,
  // including private repository names and private pull request titles, while
  // SECURITY.md described its contents as the login plus a token last-4.
  const written = JSON.stringify({
    generatedAt: NOW_MS, configured: true,
    counts: { review: 2, blocked: 1, ready: 0, total: 3, overdue: 1, drained: 4 },
    fetchNotice: "172 newer not fetched", lastError: "",
    account: { login: "rlee", last4: "abcd" },
  })
  assert.equal(/repo|title|guid|url/.test(written), false, "no row field in the record")
  const back = Model.parseState(written)
  assert.equal(back.valid, true)
  assert.equal(back.queue.length, 0)
  assert.equal(back.counts.total, 3)
  assert.equal(back.counts.overdue, 1)
  assert.equal(back.counts.drained, 4)
  assert.equal(back.fetchNotice, "172 newer not fetched")
  assert.equal(back.account.last4, "abcd")
})

test("parseInternal carries the setup-seen flag and defaults it off", () => {
  assert.equal(Model.parseInternal("").setupSeen, false)
  assert.equal(Model.parseInternal(JSON.stringify({ setupSeen: true })).setupSeen, true)
  assert.equal(Model.parseInternal(JSON.stringify({ setupSeen: "yes" })).setupSeen, false)
})

// ------------------------------------------------------------------ ES5 --

test("Model.js stays ES5 so the QML engine accepts it", () => {
  // A let, const, arrow, or template literal passes node --test cleanly and
  // only fails inside Quickshell's JS engine at runtime, where the failure
  // surfaces as an empty widget and one console line nobody sees.
  const src = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  assert.equal(/\b(let|const)\s/.test(code), false, "let/const in Model.js")
  assert.equal(/=>/.test(code), false, "arrow function in Model.js")
  assert.equal(/require\(/.test(code), false, "require() in Model.js")
  // Spread is "..." immediately followed by an identifier; the GraphQL inline
  // fragment "... on PullRequest" inside a string literal is not spread.
  assert.equal(/\.\.\.[A-Za-z_$]/.test(code), false, "spread in Model.js")
})

test("no em dash or en dash survives in any shipped file", () => {
  const root = path.join(__dirname, "..")
  const files = ["Model.js", "Service.qml", "BarWidget.qml", "Panel.qml",
    "manifest.json", "README.md", "SECURITY.md", "VERIFICATION.md",
    "bin/docket-login", "docs/FIXTURES.md"]
  for (const f of files) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) continue
    const body = fs.readFileSync(p, "utf8")
    // Escapes, not literals, so a repo-wide grep for the characters stays clean.
    assert.equal(/[\u2013\u2014]/.test(body), false, "dash in " + f)
  }
})
