const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.join(__dirname, "..")
const read = (name) => fs.readFileSync(path.join(root, name), "utf8")
const Model = require("../Model.js")

test("every Model function called by production QML exists on the export surface", () => {
  const qml = ["BarWidget.qml", "Panel.qml", "Service.qml"].map(read).join("\n")
  const called = [...qml.matchAll(/Model\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1])
  assert.ok(called.length > 0)
  for (const name of new Set(called)) assert.equal(typeof Model[name], "function", name)
})

test("manifest, service, bar host, and panel use one module id", () => {
  const id = JSON.parse(read("manifest.json")).id
  assert.match(read("Service.qml"), new RegExp(`moduleId: "${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))
  for (const file of ["BarWidget.qml", "Panel.qml"])
    assert.match(read(file), new RegExp(`moduleName: "${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))
})

test("manifest entry points exist inside the repository", () => {
  const manifest = JSON.parse(read("manifest.json"))
  for (const entry of Object.values(manifest.entryPoints)) {
    const resolved = path.resolve(root, entry)
    assert.ok(resolved.startsWith(root + path.sep))
    assert.equal(fs.statSync(resolved).isFile(), true)
  }
})

test("service startup explicitly resolves both persisted-record reads", () => {
  const service = read("Service.qml")
  assert.match(service, /Component\.onCompleted\s*:\s*\{[\s\S]*credsFile\.reload\(\)[\s\S]*internalFile\.reload\(\)/)
  assert.match(service, /if \(!root\.stateLoaded \|\| !root\.credsLoaded\)/)
  assert.match(service, /if \(root\.polling \|\| !root\.stateLoaded \|\| !root\.credsLoaded\) return/)
  assert.match(service, /if \(root\.stateLoaded && root\.credsLoaded[\s\S]*root\.rebuild\(\)/)
})

test("marketplace copy and authored Docket banner are release artifacts", () => {
  const manifest = JSON.parse(read("manifest.json"))
  assert.equal(manifest.description.length, 500)
  assert.match(manifest.description, /review clock/)
  assert.match(manifest.description, /credentials stay local/)
  const banner = read("assets/banner.svg")
  assert.match(banner, /<title[^>]*>Docket<\/title>/)
  assert.match(banner, /WAITING REVIEW/)
  assert.match(banner, /BLOCKED ON YOU/)
  assert.match(banner, /READY TO MERGE/)
  assert.match(banner, /<(?:path|circle)\b/)
})

test("render tooling forbids the old shared, cropped, provenance-free lane", () => {
  const render = read("scripts/rig-render.sh")
  assert.match(render, /OMARCHY_RIG_RESOLUTION:-1280x720/)
  assert.match(render, /OMARCHY_RIG_SCALE:-1\.25/)
  assert.match(render, /rawShellLogSha256/)
  assert.match(render, /visualInspection:\{status:"pending"/)
  assert.match(render, /grim "\\\$SHOT"/)
  assert.doesNotMatch(render, /grim -g|pkill/)

  const approval = read("scripts/approve-preview.sh")
  assert.match(approval, /product value is visible without reading the README/)
  assert.match(approval, /no primary content is clipped/)
  assert.match(approval, /plugin-specific visual identity/)
})
