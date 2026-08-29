const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const Model = require("../Model.js")

const fixture = fs.readFileSync(path.join(__dirname, "..", "e2e", "search-render-scrubbed.json"), "utf8")
const clone = value => JSON.parse(JSON.stringify(value))
const parsed = Model.parseSearch(fixture)
const queue = Model.buildQueue(clone(parsed), { botPullRequests: "Hide", myDrafts: "Hide" })
const now = Date.parse("2026-08-29T18:00:00Z")

function normalized(overrides = {}) {
  const base = {
    number: 42, title: "Ship <safe> output", isDraft: false,
    createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
    author: { login: "alice", __typename: "User" },
    repository: { nameWithOwner: "acme/widget", isPrivate: true, isArchived: false },
    isCrossRepository: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] }
  }
  return Model.normalizeNode(Object.assign(base, overrides), "review")
}

test("the exported model contract has a broad deterministic mutation signature", () => {
  const cases = {
    constants: [Model.MAX_BODY_CHARS, Model.MAX_NODES, Model.MAX_QUEUE, Model.MAX_ROWS,
      Model.MAX_TITLE_CHARS, Model.PAGE_SIZE, Model.LANE_REVIEW, Model.LANE_BLOCKED,
      Model.LANE_READY, Model.DEFAULT_SLA_HOURS, Model.MIN_SLA_HOURS, Model.MAX_SLA_HOURS,
      Model.STAMP_RETENTION_MS, Model.ERROR_CODES, String(Model.PR_URL_RE)],
    num: [undefined, null, "", "x", -1, 0, "4.5"].map(Model.num),
    clean: [
      Model.clean(undefined, 4), Model.clean(null, 4), Model.clean("abc", 4),
      Model.clean("abcde", 4), Model.clean("<x>\u0000\u202e", 40),
      Model.clean("abc\ud83d\ude00", 4), Model.clean("abc\ud800Z", 4),
      Model.clean("abc\udbffZ", 4), Model.clean("abcd", 4)
    ],
    urls: [
      Model.prUrl("acme/widget", 7), Model.prUrl("bad", 7), Model.prUrl("a/b", null),
      Model.prUrl(`${"a".repeat(39)}/${"b".repeat(100)}`, "9".repeat(10)),
      Model.prUrl(`${"a".repeat(40)}/b`, 1), Model.prUrl(`a/${"b".repeat(101)}`, 1),
      Model.prUrl("a/b", "9".repeat(11)), Model.prUrl("a!/b?", "-12x")
    ],
    safeUrls: ["https://github.com/a/b/pull/1", "xhttps://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1x", "https://github.com/a/b/pull/1;id", null]
      .map(Model.isSafePrUrl),
    spoof: ["", "acme/widget", "acme", "acme/wid get", "a\u202e/b", "mi\u0441rosoft/repo"]
      .map(Model.isSpoofy),
    search: [-1, 0, 1, 50].map(value => ({ fields: Model.searchFields(value),
      query: Model.graphqlQuery(value), body: Model.graphqlBody(value) })),
    rollup: [null, {}, { commits: { nodes: [] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "EXPECTED" } } }] } },
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "OTHER" } } }] } }
    ].map(Model.rollupState),
    decisions: [null, {}, { reviewDecision: "APPROVED" }, { reviewDecision: "CHANGES_REQUESTED" },
      { reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } },
      { reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] } },
      { reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }] } }
    ].map(Model.effectiveDecision),
    merge: [null, {}, { mergeable: "MERGEABLE" }, { mergeable: "CONFLICTING" },
      { mergeable: "UNKNOWN" }].map(Model.mergeState),
    normalize: [normalized(), normalized({ number: null }), normalized({ number: undefined }), normalized({ repository: null }),
      normalized({ author: null }), normalized({ title: "x".repeat(300) }),
      normalized({ repository: { nameWithOwner: "mi\u0441rosoft/repo", isPrivate: false } }),
      normalized({ createdAt: null, updatedAt: null, isDraft: true, isCrossRepository: true }),
      normalized({ repository: { nameWithOwner: "bad", isPrivate: false } })],
    parse: [Model.emptyParse(), Model.parseSearch(""), Model.parseSearch("{"),
      Model.parseSearch(JSON.stringify({ data: { reviewRequested: {}, mine: {} } })), parsed],
    notice: [null, Model.emptyParse(), parsed,
      Object.assign({}, parsed, { reviewTruncated: false, reviewTotal: 10, reviewFetched: 2,
        mineTruncated: false, mineTotal: 7, mineFetched: 4 }),
      Object.assign({}, parsed, {
      reviewTruncated: true, reviewTotal: 10, reviewFetched: 2,
      mineTruncated: true, mineTotal: 7, mineFetched: 4
    })].map(Model.fetchNoticeText),
    classify: [null,
      { isDraft: true, decision: "APPROVED", mergeable: "MERGEABLE", ci: "green" },
      { isDraft: false, decision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", ci: "red" },
      { isDraft: false, decision: "APPROVED", mergeable: "MERGEABLE", ci: "green" },
      { isDraft: false, decision: "APPROVED", mergeable: "UNKNOWN", ci: "pending" }
    ].map(item => ({ lane: Model.classifyMine(item), item })),
    reviewReasons: [null, { ci: "red", mergeable: "CONFLICTING", decision: "CHANGES_REQUESTED" },
      { ci: "none", mergeable: "MERGEABLE", decision: "REVIEW_REQUIRED" },
      { ci: "green", mergeable: "MERGEABLE", decision: "APPROVED" }].map(Model.reviewReason),
    queue: [
      Model.buildQueue(clone(parsed), { botPullRequests: "Hide", myDrafts: "Hide" }),
      Model.buildQueue(clone(parsed), { botPullRequests: "Show", myDrafts: "Show" }),
      Model.buildQueue({ reviewRequested: [normalized()], mine: [normalized()] }, { botPullRequests: "Show", myDrafts: "Show" }),
      Model.buildQueue({ reviewRequested: [], mine: [normalized({ isDraft: true })] }, { myDrafts: "Hide" }),
      Model.buildQueue({ reviewRequested: [], mine: [normalized({ isDraft: true })] }, { myDrafts: "Show" })
    ],
    drain: {
      stamp: [Model.stampOf(null), Model.stampOf(queue[0])],
      drained: [Model.isDrained({}, queue[0]), Model.isDrained({ [Model.stampOf(queue[0])]: 1 }, queue[0])],
      applied: Model.applyDrained(queue, { [Model.stampOf(queue[0])]: 1 }),
      pruned: Model.pruneDrained({ [Model.stampOf(queue[0])]: true, "gone#1@2": now - Model.STAMP_RETENTION_MS - 1 }, queue, now),
      stamps: [
        Model.pruneStamps({ live: true, recent: now - 10, old: now - Model.STAMP_RETENTION_MS - 1, zero: 0 }, { live: true }, now),
        Model.pruneStamps({ edge: now - Model.STAMP_RETENTION_MS }, {}, now),
        Model.pruneStamps(Object.create({ inherited: now }), {}, now)
      ]
    },
    clock: {
      clamp: [undefined, 0, 1, 1.9, 24, 168, 169, "x"].map(Model.clampSla),
      hours: [[0, now], [now, now], [now - 3600000, now], [now + 1, now]].map(x => Model.ageHours(...x)),
      overdue: [Model.isOverdue(null, 24, now),
        Model.isOverdue({ updatedMs: now - 24 * 3600000 }, 24, now),
        ...queue.slice(0, 2).flatMap(item => [Model.isOverdue(item, 24, now), Model.isOverdue(item, 168, now)])],
      age: [0, now, now - 30000, now - 3600000, now - 47 * 3600000,
        now - 48 * 3600000, now - 86400000].map(at => Model.ageText(at, now)),
      checked: [0, now, now - 30000, now - 3600000].map(at => Model.checkedText(at, now))
    },
    display: {
      lanes: [Model.laneRows(queue, "review", 0), Model.laneRows(queue, "review", 1),
        Model.laneRows(queue, "blocked", 12), Model.laneRows(queue, "bad", 12)],
      counts: [Model.emptyCounts(), Model.counts(null, 24, now), Model.counts([], 24, now),
        Model.counts(queue, 24, now), Model.counts([{ lane: "bad", updatedMs: 0 }], 24, now)],
      pills: [Model.pillText(Model.emptyCounts()),
        Model.pillText({ review: 1, blocked: 0, ready: 0, overdue: 0 }),
        Model.pillText({ review: 0, blocked: 1, ready: 0, overdue: 0 }),
        Model.pillText({ review: 0, blocked: 0, ready: 1, overdue: 0 }),
        Model.pillText({ review: 1, blocked: 1, ready: 1, overdue: 0 }),
        Model.pillText(Model.counts(queue, 24, now))],
      setup: [Model.setupPillText(false), Model.setupPillText(true)],
      tips: [Model.tooltipText(Model.emptyCounts(), false, 0, now, "not connected"),
        Model.tooltipText({ review: 0, blocked: 0, ready: 0, overdue: 0 }, true, 0, now, ""),
        Model.tooltipText({ review: 1, blocked: 0, ready: 0, overdue: 0 }, true, now, now, ""),
        Model.tooltipText({ review: 0, blocked: 1, ready: 0, overdue: 0 }, true, now - 60000, now, "api error"),
        Model.tooltipText({ review: 0, blocked: 0, ready: 1, overdue: 0 }, true, now - 60000, now, ""),
        Model.tooltipText(Model.counts(queue, 24, now), true, now - 60000, now, "")]
    },
    errors: [0, 200, 401, 403, 429, 500].map(Model.httpErrorCode),
    allowed: ["", "not connected", "fetch failed", "rate limited", "api error", "private"].map(Model.isAllowedError),
    notify: {
      fresh: [Model.newNotifiables(null, {}), Model.newNotifiables(queue, { [queue[0].guid]: now })],
      pruned: Model.pruneNotified({ [queue[0].guid]: true, gone: now - Model.STAMP_RETENTION_MS - 1 }, queue, now),
      headlines: [null, ...queue.slice(0, 3)].map(Model.notificationHeadline),
      bodies: [null, ...queue.slice(0, 3)].map(Model.notificationBody)
    },
    persistence: {
      emptyInternal: Model.emptyInternal(), emptyState: Model.emptyState(),
      internal: ["", "{", "{}", "[]", "null",
        JSON.stringify({ firstRun: false, setupSeen: true, drained: [], notified: [] }),
        JSON.stringify({ firstRun: false, setupSeen: true, drained: { a: 1 }, notified: { b: 2 } })]
        .map(Model.parseInternal),
      states: ["", "{", "{}", "[]", "null",
        JSON.stringify({ configured: false, counts: null, account: null, lastError: "private" }),
        JSON.stringify({ configured: true, generatedAt: now,
        counts: { review: 1, blocked: 2, ready: 3, overdue: 2, drained: 1 },
        fetchNotice: "4 newer not fetched", lastError: "rate limited",
        account: { login: "alice", last4: "123456" } })].map(Model.parseState)
    }
  }

  const signature = crypto.createHash("sha256").update(JSON.stringify(cases)).digest("hex")
  assert.equal(signature, "a4f0830a38a150d821ea399c72805722300fdbcd860b1893f746a9c1ec6ecac1")
})

test("security and queue boundaries remain observable at their exact edges", () => {
  // A short lone high surrogate must not enter the truncation branch. This
  // pins the condition itself instead of merely pinning the common output.
  assert.equal(Model.clean("\ud800", 4), "\ud800")

  assert.equal(Model.effectiveDecision({
    reviewDecision: null,
    latestOpinionatedReviews: { nodes: [{ state: "DISMISSED" }] }
  }), "")

  const duplicate = normalized({ number: 701 })
  const deduped = Model.buildQueue({
    valid: true,
    reviewRequested: [duplicate, clone(duplicate)],
    mine: [clone(duplicate)]
  }, { botPullRequests: "Show", myDrafts: "Show" })
  assert.equal(deduped.length, 1)

  assert.deepEqual(
    Model.pruneStamps({ legacy: true }, {}, now),
    { legacy: now }
  )

  const tied = Model.counts([
    { lane: "review", updatedMs: 100, repo: "first/repo" },
    { lane: "blocked", updatedMs: 100, repo: "second/repo" }
  ], 24, 100)
  assert.equal(tied.oldestRepo, "first/repo")

  assert.equal(Model.pillText({ total: 1, overdue: 0, review: 0, blocked: 1, ready: 1 }), "1 on your docket")
  assert.equal(Model.pillText({ total: 1, overdue: 0, review: 1, blocked: 1, ready: 0 }), "1 on your docket")
  assert.equal(Model.pillText({ total: 1, overdue: 0, review: 0, blocked: 0, ready: 1 }), "1 to merge")

  assert.equal(Model.parseSearch(JSON.stringify({
    data: { reviewRequested: "wrong", mine: { nodes: [] } }
  })).valid, false)
  assert.equal(Model.parseSearch(JSON.stringify({
    data: { reviewRequested: { nodes: [] }, mine: "wrong" }
  })).valid, false)

  assert.equal(Model.parseState(JSON.stringify({ counts: "wrong" })).valid, false)
  assert.equal(Model.parseState(JSON.stringify({ counts: null, queue: "wrong" })).valid, false)

  const legacy = Model.parseState(JSON.stringify({
    configured: false,
    queue: [
      { guid: "a#1", repo: "a/b", number: 1, lane: "reviewX",
        repoSpoofy: false, isBot: false, isDraft: false, isPrivate: false, isFork: false },
      { guid: "a#2", repo: "a/b", number: 2, lane: "Xreview",
        repoSpoofy: true, isBot: true, isDraft: true, isPrivate: true, isFork: true }
    ]
  }))
  assert.equal(legacy.valid, true)
  assert.deepEqual(legacy.queue.map(item => ({
    lane: item.lane,
    repoSpoofy: item.repoSpoofy,
    isBot: item.isBot,
    isDraft: item.isDraft,
    isPrivate: item.isPrivate,
    isFork: item.isFork
  })), [
    { lane: "review", repoSpoofy: false, isBot: false, isDraft: false, isPrivate: false, isFork: false },
    { lane: "review", repoSpoofy: true, isBot: true, isDraft: true, isPrivate: true, isFork: true }
  ])
})
