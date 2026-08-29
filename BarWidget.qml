import QtQuick
import qs.Commons
import qs.Ui

// Bar host. Mirrors the first-party split: this widget owns the bar slot and
// pill button; Panel.qml owns data, lifecycle, and the popup.
BarWidget {
  id: root
  moduleName: "io.github.jeremylongshore.docket"

  // The service singleton this plugin's "service" kind loaded. The shell
  // injects `service` into PANEL-kind plugins only; a bar widget receives just
  // bar/moduleName/settings, so resolve it ourselves through the bar's shell
  // handle. It carries the item store and the poll cycle; the panel renders it
  // and calls into it.
  property var service: null

  // serviceFor() returns null until the shell has finished loading the
  // service singleton, and it is not a bound property, so poll briefly at
  // startup rather than binding once and latching null forever.
  function resolveService() {
    if (root.service) return
    if (!root.bar || !root.bar.shell) return
    if (typeof root.bar.shell.serviceFor !== "function") return
    var svc = root.bar.shell.serviceFor(root.moduleName)
    if (svc) {
      root.service = svc
      root.injectPanel()
    }
  }

  Timer {
    interval: 500
    running: root.service === null
    repeat: true
    triggeredOnStart: true
    onTriggered: root.resolveService()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.service
  }

  onServiceChanged: injectPanel()

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  // The whole point: the slot collapses the moment the docket is drained.
  // There is no zero badge, ever. A clear docket is indistinguishable from an
  // uninstalled plugin, which is correct: a queue that nags at zero is a feed.
  // The one empty state that DOES render is a missing token, because that is
  // the only one the user has to act on.
  visible: panelLoader.item && panelLoader.item.label !== ""
  implicitWidth: visible ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  onBarChanged: { root.resolveService(); injectPanel() }
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: panelLoader.item ? panelLoader.item.label : ""
    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
    // Anything past the review clock lights the pill in the bar's active
    // color so a glance reads it without parsing the text.
    active: panelLoader.item ? panelLoader.item.isAlert === true : false
    tooltipText: panelLoader.item ? panelLoader.item.tooltip : ""
    Accessible.role: Accessible.Button
    Accessible.name: root.opened ? "Close Docket" : "Open Docket"

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
