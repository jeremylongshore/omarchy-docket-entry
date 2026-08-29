const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const Model = require("../Model.js")

test("the scrubbed render fixture proves all three lanes and overdue value", () => {
  const fixture = fs.readFileSync(new URL("../e2e/search-render-scrubbed.json", `file://${__filename}`), "utf8")
  const parsed = Model.parseSearch(fixture)
  assert.equal(parsed.valid, true)
  const queue = Model.buildQueue(parsed, { botPullRequests: "Hide", myDrafts: "Hide" })
  const counts = Model.counts(queue, 24, Date.parse("2026-08-29T18:00:00Z"))
  assert.deepEqual({ review: counts.review, blocked: counts.blocked, ready: counts.ready, total: counts.total },
    { review: 2, blocked: 2, ready: 2, total: 6 })
  assert.ok(counts.overdue >= 2)
})
