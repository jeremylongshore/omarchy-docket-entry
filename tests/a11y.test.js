const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8")

test("the bar control exposes a dynamic named button role and pointer activation", () => {
  const qml = read("BarWidget.qml")
  assert.match(qml, /Accessible\.role:\s*Accessible\.Button/)
  assert.match(qml, /Accessible\.name:\s*root\.opened\s*\?\s*"Close Docket"\s*:\s*"Open Docket"/)
  assert.match(qml, /onPressed:\s*function\(b\)/)
})

test("the popup has focus, close, tab, move, activate, and drain keyboard routes", () => {
  const qml = read("Panel.qml")
  assert.match(qml, /KeyboardPanel\s*{/)
  assert.match(qml, /focusTarget:\s*keyCatcher/)
  assert.match(qml, /PanelKeyCatcher\s*{/)
  for (const route of ["onCloseRequested", "onTabRequested", "onMoveRequested", "onActivateRequested", "onDeleteRequested"])
    assert.match(qml, new RegExp(`${route}:`), route)
})

test("every network-derived row text binding is plain and width bounded", () => {
  const qml = read("Panel.qml")
  const ids = ["repoLabel", "titleLabel", "reasonLabel"]
  for (let index = 0; index < ids.length; index++) {
    const start = qml.indexOf(`id: ${ids[index]}`)
    const end = index + 1 < ids.length ? qml.indexOf(`id: ${ids[index + 1]}`, start) : qml.indexOf("id: ageLabel", start)
    assert.notEqual(start, -1, ids[index])
    const block = qml.slice(start, end)
    assert.match(block, /textFormat:\s*Text\.PlainText/)
    assert.match(block, /width:/)
    assert.match(block, /elide:\s*Text\.Elide(?:Left|Right)/)
  }
})
