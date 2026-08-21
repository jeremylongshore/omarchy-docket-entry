import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Docket panel: renders the queue the Service owns and drives it with
// Herald-standard keys. This file never touches the network and never writes
// a file. There is NO node on a stock Omarchy install, so the whole plugin
// runs on Quickshell plus curl; Service.qml does the fetching and the
// persistence, and the panel calls straight into it, which means a drain
// keystroke takes effect synchronously instead of round-tripping through a
// CLI that could drop it.
Panel {
  id: root
  moduleName: "io.github.jeremylongshore.docket"
  ipcTarget: "io.github.jeremylongshore.docket"
  // manageIpc MUST stay false: the base Panel would otherwise register its own
  // IpcHandler on this same target and collide with the one declared below,
  // and the custom refresh() would never route.
  manageIpc: false

  property var anchorItem: null

  // The bar identifies this plugin by the widget mounted in its slot, not by
  // this nested panel.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Resolved by the BarWidget host through bar.shell.serviceFor(). Everything
  // below degrades to an empty view when it is missing rather than erroring.
  property var service: null

  // ---- Fixed behavior. Omakase constants, not knobs.
  readonly property int reviewRowsMax: 10
  readonly property int blockedRowsMax: 8
  readonly property int readyRowsMax: 6

  // One clock for the whole panel. Never call Date.now() inside a binding:
  // it makes every age string a non-reactive snapshot of whenever that binding
  // last happened to evaluate.
  property double nowMs: Date.now()

  // Bumped by the service on every store change so the computed properties
  // below re-evaluate. A JS array mutated in place does not notify QML on its
  // own, so without this the panel renders stale forever and a drain appears
  // to do nothing.
  property int revision: 0

  readonly property var queue: {
    root.revision   // dependency: re-read whenever the service signals a change
    return root.service ? root.service.queue : []
  }

  readonly property bool configured: {
    root.revision
    return root.service ? root.service.configured === true : false
  }

  readonly property double generatedAt: {
    root.revision
    return root.service ? root.service.generatedAt : 0
  }

  readonly property bool stateReady: {
    root.revision
    return root.service ? root.service.stateLoaded === true : false
  }

  readonly property string lastError: {
    root.revision
    return root.service ? String(root.service.lastError || "") : ""
  }

  readonly property int slaHours: {
    root.revision
    return root.service ? Model.clampSla(root.service.slaHours) : Model.DEFAULT_SLA_HOURS
  }

  readonly property string fetchNotice: {
    root.revision
    return root.service ? String(root.service.fetchNotice || "") : ""
  }

  readonly property bool setupSeen: {
    root.revision
    return root.service && root.service.internal
      ? root.service.internal.setupSeen === true : false
  }

  readonly property int drainedCount: {
    root.revision
    if (!root.service) return 0
    return Math.max(0, root.service.allItems.length - root.service.queue.length)
  }

  readonly property var laneCounts: Model.counts(queue, slaHours, nowMs)

  // A missing token and a clear docket must never look alike, so the setup
  // case is the one empty state that still renders a pill.
  readonly property string label: configured
    ? Model.pillText(laneCounts)
    : Model.setupPillText(false)

  readonly property string tooltip:
    Model.tooltipText(laneCounts, configured, generatedAt, nowMs, lastError)

  // The pill stays when unconfigured (a missing token is the one empty state the
  // user has to act on) but it stops holding the bar alert colour once the setup
  // tile has actually been read. Everything else here is scrupulous about not
  // nagging; an indefinitely highlighted "Docket: connect" was the exception.
  readonly property bool isAlert:
    (!configured && !setupSeen) || laneCounts.overdue > 0

  onOpenedChanged: {
    if (root.opened && !root.configured && root.service
      && typeof root.service.markSetupSeen === "function") root.service.markSetupSeen()
  }

  // Follows the service's renamed store signal. The old name collided with
  // Item's own `stateChanged` property-change signal, so this handler was
  // really riding an accidental Item signal that Qt logged as an invalid
  // override on every start. `ignoreUnknownSignals` is exactly why that
  // mistake was survivable and exactly why it stayed invisible.
  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onStoreChanged() { root.revision++ }
  }

  // ---- Rows. Three lanes flattened into one list the cursor walks; headers
  //      are inert, rows are selectable. Every object carries the SAME key set
  //      (headers fill the unused keys with zero values) or QML warns on every
  //      property lookup against a header row.
  readonly property var allRows: {
    var rows = []
    var lanes = [
      { lane: Model.LANE_REVIEW, header: "WAITING ON YOUR REVIEW", max: reviewRowsMax },
      { lane: Model.LANE_BLOCKED, header: "BLOCKED ON YOU", max: blockedRowsMax },
      { lane: Model.LANE_READY, header: "READY TO MERGE", max: readyRowsMax }
    ]
    var sel = 0
    for (var l = 0; l < lanes.length; l++) {
      var laneRows = Model.laneRows(queue, lanes[l].lane, lanes[l].max)
      if (laneRows.length === 0) continue
      rows.push({ type: "header", text: lanes[l].header, lane: lanes[l].lane,
        guid: "", repo: "", number: 0, title: "", url: "", author: "",
        reason: "", updatedMs: 0, overdue: false, isFork: false,
        isPrivate: false, repoSpoofy: false, sel: -1 })
      var laneTotal = 0
      for (var t = 0; t < queue.length; t++) if (queue[t].lane === lanes[l].lane) laneTotal++
      for (var r = 0; r < laneRows.length; r++) {
        var row = laneRows[r]
        rows.push({ type: "row", text: "", lane: row.lane, guid: row.guid,
          repo: row.repo, number: row.number, title: row.title, url: row.url,
          author: row.author, reason: row.reason, updatedMs: row.updatedMs,
          overdue: Model.isOverdue(row, root.slaHours, root.nowMs),
          isFork: row.isFork === true, isPrivate: row.isPrivate === true,
          repoSpoofy: row.repoSpoofy === true, sel: sel })
        sel++
      }
      // The pill counts the whole queue but a lane renders at most its cap, so
      // without this line rows behind the cap keep the pill lit while being
      // unselectable, unopenable, and undrainable from the panel. The user
      // drains every visible row, the pill does not move, and draining reads as
      // broken. Inert like a header, and it is also what makes `c` (which drains
      // the whole queue, not just what is on screen) comprehensible.
      var hidden = laneTotal - laneRows.length
      if (hidden > 0) {
        rows.push({ type: "more", text: hidden + " more in this lane, not shown",
          lane: lanes[l].lane, guid: "", repo: "", number: 0, title: "", url: "",
          author: "", reason: "", updatedMs: 0, overdue: false, isFork: false,
          isPrivate: false, repoSpoofy: false, sel: -1 })
      }
    }
    return rows
  }

  readonly property int selectableCount: {
    var n = 0
    for (var i = 0; i < allRows.length; i++) if (allRows[i].type === "row") n++
    return n
  }

  // The cursor is anchored to a pull request, not to an ordinal.
  //
  // allRows is rebuilt from scratch on every store change, and a background poll
  // or an `r` refresh reorders it: one PR gets a comment, its updatedMs rises,
  // the ascending sort moves it later, and every row after its old position
  // shifts up by one. A bare positional index survives that rebuild pointing at a
  // DIFFERENT pull request, with no visual event, and the next `x` drains the
  // wrong row while the highlight sits where the user aimed. Clamping the index
  // (the only reconciliation there used to be) does not help, because the count
  // is unchanged.
  //
  // So selGuid is the cursor and selIdx is derived from it, falling back to the
  // nearest surviving position when that pull request has left the docket.
  property string selGuid: ""
  property int selIdx: 0

  function indexOfGuid(g) {
    if (!g) return -1
    for (var i = 0; i < allRows.length; i++) {
      if (allRows[i].type === "row" && allRows[i].guid === g) return allRows[i].sel
    }
    return -1
  }

  function reanchor() {
    if (selectableCount === 0) { selIdx = 0; selGuid = ""; return }
    var found = indexOfGuid(root.selGuid)
    if (found >= 0) { selIdx = found; return }
    if (selIdx >= selectableCount) selIdx = selectableCount - 1
    if (selIdx < 0) selIdx = 0
    selGuid = guidAt(selIdx)
  }

  function guidAt(idx) {
    for (var i = 0; i < allRows.length; i++) {
      if (allRows[i].type === "row" && allRows[i].sel === idx) return allRows[i].guid
    }
    return ""
  }

  onAllRowsChanged: root.reanchor()

  function selectedRow() {
    for (var i = 0; i < allRows.length; i++) {
      if (allRows[i].type === "row" && allRows[i].sel === selIdx) return allRows[i]
    }
    return null
  }

  function selectIndex(idx) {
    selIdx = idx
    selGuid = guidAt(idx)
  }

  function moveCursor(dy) {
    if (selectableCount === 0) return
    var next = selIdx + dy
    if (next < 0) next = 0
    if (next >= selectableCount) next = selectableCount - 1
    root.selectIndex(next)
  }

  function openSelected() {
    var row = selectedRow()
    if (!row || row.url === "") return
    // Every stored URL was already rebuilt from stripped pieces by
    // Model.prUrl. This is the same guarantee re-tested at the point of use,
    // so an upstream regression cannot reach an argv.
    if (!Model.isSafePrUrl(row.url)) return
    if (openProc.running) return
    openProc.command = ["xdg-open", row.url]
    openProc.running = true
  }

  // Draining is deliberately NOT a side effect of opening. Reading a pull
  // request is not the same as discharging the obligation, and a queue that
  // clears itself when you glance at it is a feed with extra steps.
  function drainSelected() {
    var row = selectedRow()
    if (row && root.service) root.service.drain([row.guid])
  }

  function drainAll() {
    if (root.service) root.service.drainAll()
  }

  function undrainAll() {
    if (root.service) root.service.undrainAll()
  }

  function refresh() {
    nowMs = Date.now()
    if (root.service) root.service.poll()
  }

  function open() { root.controller.show() }
  function openFromHotkey() { root.controller.show() }
  function close() { root.controller.hide() }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  property bool popoutSwitchClosing: false
  function closeForPopoutSwitch() { root.close() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  Process { id: openProc }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void {
      // One bar surface exists per monitor and an IPC target routes to a
      // single handler, so a local refresh() would update one screen and leave
      // the others stale. Fan out through the host widget instead.
      if (root.hostWidget && typeof root.hostWidget.broadcast === "function")
        root.hostWidget.broadcast("refresh")
      else root.refresh()
    }
  }

  // ---- Popup UI.
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { root.moveCursor(dy) }
      // PanelKeyCatcher emits returnRequested THEN activateRequested on the
      // same Return press, so wiring both would open two browser tabs on one
      // keypress. Wire only activate; Space maps to it too, matching the
      // first-party agents panel. `x` is consumed by the catcher as
      // deleteRequested BEFORE textKey fires, so it is handled there and a
      // branch for it inside onTextKey would be dead code.
      onActivateRequested: root.openSelected()
      onDeleteRequested: root.drainSelected()
      onTextKey: function(t) {
        if (t === "r") root.refresh()
        else if (t === "o") root.openSelected()
        else if (t === "c") root.drainAll()
        else if (t === "u") root.undrainAll()
      }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: parent.width
          spacing: Style.space(10)

          // ---- Hero.
          Item {
            width: parent.width
            height: heroCol.implicitHeight

            Column {
              id: heroCol
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              anchors.right: parent.right
              anchors.rightMargin: Style.space(16)
              spacing: Style.space(4)

              Text {
                text: "DOCKET"
                textFormat: Text.PlainText
                color: root.bar ? root.bar.foreground : Color.foreground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
                font.letterSpacing: 1
              }

              Text {
                text: {
                  if (!root.configured)
                    return "Not connected. Run docket-login to add a GitHub token."
                  if (!root.stateReady)
                    return "Waiting for the first poll. The service checks every 15 minutes."
                  var s = root.laneCounts.total + " on your docket"
                  if (root.laneCounts.overdue > 0)
                    s += " · " + root.laneCounts.overdue + " past " + root.slaHours + "h"
                  if (root.drainedCount > 0) s += " · " + root.drainedCount + " drained"
                  if (root.fetchNotice) s += " · " + root.fetchNotice
                  // ageText returns the complete phrase "just now" under a
                  // minute, so templating "checked X ago" around it reads
                  // "checked just now ago". Model owns the whole phrase.
                  var checked = Model.checkedText(root.generatedAt, root.nowMs)
                  if (checked) s += " · " + checked
                  if (root.lastError) s += " · " + root.lastError
                  return s
                }
                textFormat: Text.PlainText
                // Prose, and every clause in it is data driven (counts, the
                // truncation notice, a mapped error), so its length is not
                // authored. Without a width and a wrap it laid out on one line
                // and the panel clipped it: the live capture read
                // "... 101 newer not fetched . c" with "checked just now"
                // sheared off at the edge. Bound it to the hero column and let
                // it wrap.
                width: heroCol.width
                wrapMode: Text.WordWrap
                color: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.muted
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }
            }
          }

          // ---- Setup tile. A missing token gets one actionable instruction,
          //      never an empty list or a zero count, because an unconfigured
          //      plugin and a clear docket are different facts.
          Column {
            visible: !root.configured
            width: parent.width
            spacing: Style.space(4)

            PanelSeparator { foreground: root.bar ? root.bar.foreground : Color.foreground }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              width: parent.width - Style.space(32)
              wrapMode: Text.WordWrap
              // Nothing in Omarchy puts a plugin's bin/ on PATH, so the bare
              // command name is not resolvable on a stock install. This tile is
              // where a stuck user actually looks, so it carries the real path.
              text: "gh auth token | ~/.config/omarchy/plugins/"
                + "io.github.jeremylongshore.docket/bin/docket-login"
              textFormat: Text.PlainText
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
            }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              width: parent.width - Style.space(32)
              wrapMode: Text.WordWrap
              text: "Symlink it once to keep it short: ln -s that path "
                + "~/.local/bin/docket-login. Or paste a classic token with the repo scope; "
                + "public_repo works too and shows public pull requests only. GitHub cannot "
                + "resolve who you are without a token, so there is no unauthenticated mode."
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          // ---- All lanes in one keyboard-walkable list.
          Repeater {
            model: root.allRows

            Item {
              id: rowItem
              required property var modelData
              readonly property bool isHeader: modelData.type === "header"
              readonly property bool isMore: modelData.type === "more"
              // Headers and the capped-lane notice are both inert: no cursor, no
              // click, no drain.
              readonly property bool isInert: isHeader || isMore
              readonly property bool isSelected: !isInert && modelData.sel === root.selIdx
              width: contentColumn.width
              height: isHeader ? Style.space(26) : Style.space(24)
              clip: true

              PanelSectionHeader {
                visible: rowItem.isHeader
                anchors.bottom: parent.bottom
                text: rowItem.isHeader ? rowItem.modelData.text : ""
                leftPadding: Style.space(16)
                foreground: root.bar ? root.bar.foreground : Color.foreground
                fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
              }

              Rectangle {
                visible: rowItem.isSelected
                anchors.fill: parent
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                radius: Style.cornerRadius
                color: root.bar ? root.bar.foreground : Color.foreground
                opacity: 0.12
              }

              Text {
                visible: rowItem.isMore
                anchors.left: parent.left
                anchors.leftMargin: Style.space(16)
                anchors.verticalCenter: parent.verticalCenter
                width: contentColumn.width - Style.space(32)
                elide: Text.ElideRight
                text: rowItem.isMore ? rowItem.modelData.text : ""
                textFormat: Text.PlainText
                color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                visible: !rowItem.isInert
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(mouse) {
                  root.selectIndex(rowItem.modelData.sel)
                  if (mouse.button === Qt.RightButton) root.drainSelected()
                  else root.openSelected()
                }
              }

              Row {
                // The row is anchored on BOTH sides, so its width is the real
                // space between the left margin and the age gutter. That width
                // is what the flexible title must be measured against: a Row
                // positioner does not clip or shrink its children, so children
                // whose widths sum past it simply paint over whatever is to the
                // right, which here is the age label.
                id: rowLine
                visible: !rowItem.isInert
                anchors.left: parent.left
                anchors.leftMargin: Style.space(16)
                anchors.right: ageLabel.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)

                // Past the review clock. The one thing no other GitHub bar
                // widget tells you: not what is waiting, but what you are late on.
                Text {
                  id: overdueDot
                  visible: rowItem.modelData.overdue === true
                  text: "●"
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  color: root.bar ? root.bar.urgent : Color.urgent
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  // A repository name whose display disagrees with the link
                  // built from it is a homoglyph spoof candidate. The warning
                  // lives in the reason column (see below), not as a "?" glyph
                  // on the name: "?" reads as missing data or a render fault,
                  // which is the opposite of "this name may be impersonating
                  // another repository".
                  //
                  // ElideLeft, and a width bound. Model.clean allows the full
                  // GitHub maximum (39-char owner + 100-char repo) and this
                  // Text had neither, so a long name pushed the title and reason
                  // rightward and painted over the age label in the right
                  // gutter, on the exact row the overdue marker says you are
                  // late on. Eliding from the left keeps ".../platform-infra",
                  // and the repo half disambiguates where the owner half does not.
                  id: repoLabel
                  text: rowItem.isInert ? "" :
                    rowItem.modelData.repo + " #" + rowItem.modelData.number
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideLeft
                  maximumLineCount: 1
                  width: Math.min(implicitWidth, Math.round(rowLine.width * 0.30))
                  color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  // The title is the ONE elastic column: it takes whatever the
                  // row has left after the fixed-share repo name, the reason,
                  // the overdue dot and the gaps between them. The previous
                  // bound was a constant subtracted from the COLUMN width
                  // (contentColumn.width - space(300)), which ignored both the
                  // age gutter and the two 30-percent siblings, so on a narrow
                  // panel the children summed past the row and the reason text
                  // painted straight through the age label. The live capture
                  // showed "conflicts, chec" overprinting "148d" on the very
                  // rows the overdue dot says you are late on.
                  id: titleLabel
                  text: rowItem.isInert ? "" : rowItem.modelData.title
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  color: root.bar ? root.bar.foreground : Color.foreground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  font.bold: rowItem.modelData.overdue === true
                  elide: Text.ElideRight
                  maximumLineCount: 1
                  width: Math.max(0, rowLine.width
                    - repoLabel.width
                    - (overdueDot.visible ? overdueDot.width + rowLine.spacing : 0)
                    - (reasonLabel.visible ? reasonLabel.width + rowLine.spacing : 0)
                    - rowLine.spacing)
                }

                Text {
                  // The spoof warning goes in the column the user already reads
                  // for explanations, in words.
                  id: reasonLabel
                  readonly property string reasonText: rowItem.isInert ? "" :
                    (rowItem.modelData.repoSpoofy
                      ? "look-alike repo name" + (rowItem.modelData.reason ? ", " : "")
                      : "") + rowItem.modelData.reason
                  visible: !rowItem.isInert && reasonText !== ""
                  text: reasonText
                  textFormat: Text.PlainText
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideRight
                  maximumLineCount: 1
                  width: Math.min(implicitWidth, Math.round(rowLine.width * 0.30))
                  color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.caption
                }
              }

              Text {
                id: ageLabel
                visible: !rowItem.isInert
                anchors.right: parent.right
                anchors.rightMargin: Style.space(16)
                anchors.verticalCenter: parent.verticalCenter
                width: Math.min(implicitWidth, Style.space(64))
                elide: Text.ElideRight
                text: rowItem.isInert ? "" : Model.ageText(rowItem.modelData.updatedMs, root.nowMs)
                textFormat: Text.PlainText
                color: rowItem.modelData.overdue === true
                  ? (root.bar ? root.bar.urgent : Color.urgent)
                  : (root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted)
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }

          // ---- Empty state. Only ever shown when there is genuinely nothing
          //      owed, never when the plugin is simply unconfigured.
          Text {
            visible: root.configured && root.stateReady && root.allRows.length === 0
            anchors.left: parent.left
            anchors.leftMargin: Style.space(16)
            width: parent.width - Style.space(32)
            wrapMode: Text.WordWrap
            text: root.drainedCount > 0
              ? "Docket clear. " + root.drainedCount + " drained; press u to bring them back."
              : "Docket clear. Nothing is waiting on you."
            textFormat: Text.PlainText
            color: root.bar ? Qt.darker(root.bar.foreground, 1.35) : Color.muted
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
          }

          // ---- Footer: keys and the honesty line.
          Column {
            width: parent.width
            spacing: Style.space(2)

            PanelSeparator { foreground: root.bar ? root.bar.foreground : Color.foreground }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              width: parent.width - Style.space(32)
              wrapMode: Text.WordWrap
              // "u restore all", not "u undo": undrainAll() restores EVERY drain
              // ever made, and "undo" in a list UI means "undo my last action".
              text: "j/k move · enter open · x drain · c drain all · u restore all · r refresh"
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(16)
              width: parent.width - Style.space(32)
              wrapMode: Text.WordWrap
              text: "Draining hides a pull request until it changes. Opening one never drains it."
              textFormat: Text.PlainText
              color: root.bar ? Qt.darker(root.bar.foreground, 1.45) : Color.muted
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          Item { width: 1; height: Style.space(4) }
        }
      }
    }
  }
}
