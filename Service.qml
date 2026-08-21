import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Docket background service: owns the whole poll cycle, the queue store, and
// persistence, in QML, with NO external runtime. A stock Omarchy install has
// no node, python, or ruby on the graphical session PATH (Omarchy installs
// node through mise, whose shims are not exported to the session that
// launches Quickshell), so a plugin with an external poller installs cleanly,
// enables cleanly, and then silently never populates. This one depends on
// nothing but Quickshell and the curl every Omarchy box already ships.
//
// The GitHub token is read from credentials.json (written only by
// bin/docket-login) and handed to curl over STDIN via `--header @-`, exactly
// as the first-party network panel passes a wifi passphrase, so it never
// appears in a process argv and is never visible to ps.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string moduleId: "io.github.jeremylongshore.docket"
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateDir:
    (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/docket"
  readonly property string statePath: stateDir + "/state.json"
  readonly property string internalPath: stateDir + "/internal.json"
  readonly property string credsPath: stateDir + "/credentials.json"

  readonly property string apiUrl: "https://api.github.com/graphql"

  // 15 minutes, matching the first-party agents refresh. The transport makes
  // the cadence question moot rather than tight: one GraphQL POST answers both
  // inboxes for a measured 2 points of a 5000-point hourly budget at
  // PAGE_SIZE 50, so four polls an hour spend 0.16 percent of it. REST search
  // would have cost two requests against a 30-per-MINUTE budget with no ETag
  // and no CI, review-decision, or mergeable field at all.
  readonly property int pollIntervalSec: 900
  readonly property int fetchTimeoutSec: 20
  readonly property int notifyCap: 3

  // ---- Settings, read from this plugin's own bar-layout entry in shell.json.
  //      A service is not a bar widget, so it cannot use BarWidget.setting().
  property string notificationsMode: "On"
  property int slaHours: Model.DEFAULT_SLA_HOURS
  property string botPullRequests: "Hide"
  property string myDrafts: "Hide"

  // ---- Credentials. Read-only here; only bin/docket-login ever writes them.
  //      That asymmetry is what makes "the plugin cannot leak the token into a
  //      tracked file" a structural property rather than a promise.
  property string token: ""
  property string login: ""
  readonly property bool configured: token !== "" && login !== ""

  // ---- Store.
  property var internal: Model.emptyInternal()
  property var allItems: []      // everything the last poll classified
  property var queue: []         // allItems minus what has been drained
  property double generatedAt: 0
  property string lastError: ""
  property bool stateLoaded: false
  property bool credsLoaded: false
  property bool polling: false
  property var pendingNotifications: []
  // The last VALID parse, kept so a settings change can rebuild the queue
  // without a network round trip.
  property var lastParsed: null
  property string fetchNotice: ""

  signal stateChanged()

  // ------------------------------------------------------------- settings

  function readSettings() {
    var conf
    try { conf = JSON.parse(shellConfigFile.text() || "") } catch (e) { return }
    if (!conf || !conf.bar || !conf.bar.layout) return
    var zones = ["left", "center", "right"]
    for (var z = 0; z < zones.length; z++) {
      var list = conf.bar.layout[zones[z]] || []
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        if (!e || e.id !== root.moduleId) continue
        root.notificationsMode = e.notifications === "Off" ? "Off" : "On"
        // Clamp every settings-derived number. A fat-fingered or hostile value
        // must not be able to turn a bounded behavior into an unbounded one.
        root.slaHours = Model.clampSla(e.slaHours)
        root.botPullRequests = e.botPullRequests === "Show" ? "Show" : "Hide"
        root.myDrafts = e.myDrafts === "Show" ? "Show" : "Hide"
        return
      }
    }
  }

  function queueOpts() {
    return { botPullRequests: root.botPullRequests, myDrafts: root.myDrafts }
  }

  // A settings change is a pure filter or threshold change: it needs no network
  // call, only a re-run of the classifier over the response already in hand.
  // Without this, flipping "Bot-authored pull requests" to Show did nothing for
  // up to 15 minutes and read as a broken toggle, because allItems was only ever
  // recomputed inside finishPoll.
  function rebuild() {
    if (!root.lastParsed) { root.persist(); return }
    root.allItems = Model.buildQueue(root.lastParsed, root.queueOpts())
    root.persist()
  }

  function onSettingsFileChanged() {
    var before = root.botPullRequests + "|" + root.myDrafts + "|" + root.slaHours
      + "|" + root.notificationsMode
    root.readSettings()
    if (before !== root.botPullRequests + "|" + root.myDrafts + "|" + root.slaHours
      + "|" + root.notificationsMode) root.rebuild()
  }

  // -------------------------------------------------------------- fetching
  //
  // Every argv element below is a constant or the query document this plugin
  // authored. The credential is absent BY CONSTRUCTION: `--header @-` tells
  // curl to read header lines from stdin, and Process.onStarted is the only
  // place the token is ever written.
  //
  // Flag choices, each one a decision rather than a default:
  //   --proto =https   exactly https. No http, no file, no scp.
  //   --max-time       a wall-clock bound on the whole transfer.
  //   --max-filesize   a byte bound, but only when the server sends
  //                    Content-Length; GitHub commonly chunks, so the real
  //                    bound is Model.MAX_BODY_CHARS before JSON.parse.
  //   -sS not -fsS     -f suppresses the body on 4xx, and the body is where
  //                    GitHub explains a rate limit or a missing scope. The
  //                    status arrives through -w and is split off below.
  //   no -L            a shipped URL must be the real one. A source that
  //                    starts redirecting has to fail loudly, not follow
  //                    silently to a host nobody vetted.
  //   --               ends option parsing before the URL.
  function apiArgs(body) {
    return ["curl", "-sS", "--proto", "=https",
      "--max-time", String(root.fetchTimeoutSec),
      "--max-filesize", String(Model.MAX_BODY_CHARS),
      "-o", "-", "-w", "\n%{http_code}",
      "-H", "Content-Type: application/json",
      "-H", "User-Agent: docket/1.0 (Omarchy bar widget)",
      "--header", "@-",
      "-d", body,
      "--", root.apiUrl]
  }

  // ------------------------------------------------------------------ poll

  function poll() {
    // Never poll before the persisted record has loaded: the firstRun
    // decision must be made against real history, or the very first launch
    // back-notifies the user's entire backlog.
    if (root.polling || !root.stateLoaded || !root.credsLoaded) return
    root.readSettings()
    if (!root.configured) { root.lastError = "not connected"; root.persist(); return }
    root.polling = true
    root.lastError = ""
    apiProc.stdinEnabled = true
    apiProc.command = root.apiArgs(Model.graphqlBody(Model.PAGE_SIZE))
    apiProc.running = true
  }

  function onApiResponse(raw) {
    // onExited and onStreamFinished can fire in either order, and onExited
    // already has this guard. A curl that streams half a body and then exits
    // non-zero on --max-time would otherwise drive finishPoll twice for one
    // poll: once as "fetch failed", then again off the truncated text, which
    // re-enters the notify and prune block for an already-finished cycle.
    if (!root.polling) return
    var text = String(raw || "")
    var nl = text.lastIndexOf("\n")
    var code = nl >= 0 ? parseInt(text.slice(nl + 1), 10) || 0 : 0
    var body = nl >= 0 ? text.slice(0, nl) : ""

    if (code !== 200) { root.finishPoll(Model.httpErrorCode(code), null); return }

    var parsed = Model.parseSearch(body)
    // GraphQL occasionally answers with an nginx 502 HTML page rather than
    // JSON. parseSearch returns its zero object rather than throwing, and the
    // last good snapshot stays on screen with a stale timestamp instead of
    // the panel blanking.
    if (!parsed.valid) { root.finishPoll("api error", null); return }
    root.lastParsed = parsed
    root.finishPoll("", parsed)
  }

  function finishPoll(errorCode, parsed) {
    var nowMs = Date.now()
    // Only a mapped constant may ever reach lastError. Never captured output:
    // an error path is the most natural-looking place for a token or a private
    // repository name to reach a file the user will paste into a bug report.
    root.lastError = Model.isAllowedError(errorCode) ? errorCode : "api error"

    if (parsed) {
      root.allItems = Model.buildQueue(parsed, root.queueOpts())
      root.fetchNotice = Model.fetchNoticeText(parsed)
      // Both prunes are time bounded, not presence bounded: an entry survives
      // STAMP_RETENTION_MS of absence. Presence-based pruning let one transient
      // shrink of the result set delete a drain the user had made, so the row
      // returned on the next healthy poll and re-notified.
      root.internal.drained = Model.pruneDrained(root.internal.drained, root.allItems, nowMs)
      var visible = Model.applyDrained(root.allItems, root.internal.drained)

      if (root.internal.firstRun) {
        // History is not news. Mark the whole opening docket seen so the pill
        // starts quiet and nothing back-notifies.
        for (var f = 0; f < visible.length; f++) root.internal.notified[visible[f].guid] = nowMs
        root.internal.firstRun = false
      } else if (root.notificationsMode === "On") {
        var fresh = Model.newNotifiables(visible, root.internal.notified)
        for (var m = 0; m < fresh.length; m++) root.internal.notified[fresh[m].guid] = nowMs
        root.notifyFresh(fresh)
      }
      root.internal.notified = Model.pruneNotified(root.internal.notified, root.allItems, nowMs)
      root.generatedAt = nowMs
    }

    root.polling = false
    root.persist()
  }

  // ------------------------------------------------------------ notifying
  //
  // A review queue is not an incident, so urgency is always low, and an error
  // state never raises a toast: failing loudly on a transient network blip
  // trains a user to dismiss everything this plugin says.

  function notifyFresh(fresh) {
    if (!fresh || fresh.length === 0) return
    if (fresh.length > root.notifyCap) {
      root.sendNotification(["-u", "low", "--app-name", "Docket"],
        "Docket", fresh.length + " pull requests landed on your docket")
      return
    }
    root.pendingNotifications = fresh.slice(0)
    root.sendNextNotification()
  }

  function sendNextNotification() {
    if (root.pendingNotifications.length === 0) return
    var it = root.pendingNotifications[0]
    root.pendingNotifications = root.pendingNotifications.slice(1)
    var flags = ["-u", "low", "--app-name", "Docket"]
    // Omarchy dispatches the --exec value through `bash -lc "<value>"`, so the
    // URL is single-quoted. That is safe ONLY because the charset re-tested on
    // the very next line contains no single quote, no backslash, no dollar, no
    // backtick, and no space, which means the quoting cannot be escaped out
    // of. The re-test runs here, at the point of use, and not only where the
    // URL was built, so a regression in Model.prUrl removes the click action
    // rather than shipping an injectable one. Nothing network-authored other
    // than this rebuilt URL ever enters an --exec value: not the title, not
    // the author, not the branch.
    if (it.url && Model.PR_URL_RE.test(it.url)) {
      flags.push("--exec", "xdg-open '" + it.url + "'")
    }
    root.sendNotification(flags,
      Model.notificationHeadline(it), Model.notificationBody(it))
  }

  // Flags first, network-derived positionals last behind "--", with a
  // leading-dash strip, so a pull request titled "--exec" or "-u critical"
  // cannot be reparsed as an option by omarchy-notification-send.
  function sendNotification(flags, headline, body) {
    var args = flags.concat(["--", root.stripLead(headline)])
    if (body !== undefined) args.push(root.stripLead(body))
    notifyProc.command = ["omarchy-notification-send"].concat(args)
    notifyProc.running = true
  }

  function stripLead(s) {
    return String(s === undefined ? "" : s).replace(/^[-\s]+/, "")
  }

  // ------------------------------------------------------------ mutations
  //
  // Synchronous in-memory writes plus a persist, never a CLI round trip.
  // This service is the single owner of the store, so a keystroke can never
  // be dropped or reverted by a racing writer.
  //
  // A drain is keyed on the pull request's updatedAt, not its number, so
  // dismissing a row hides it only until that pull request actually changes.
  // A new push, review, or comment mints a new stamp and puts it straight
  // back on the docket. That is the difference between a queue and a mute.

  function drain(guids) {
    if (!guids || guids.length === 0) return
    var changed = false
    for (var g = 0; g < guids.length; g++) {
      for (var i = 0; i < root.allItems.length; i++) {
        if (root.allItems[i].guid !== guids[g]) continue
        root.internal.drained[Model.stampOf(root.allItems[i])] = Date.now()
        changed = true
      }
    }
    if (changed) root.persist()
  }

  function drainAll() {
    if (root.queue.length === 0) return
    for (var i = 0; i < root.queue.length; i++) {
      root.internal.drained[Model.stampOf(root.queue[i])] = Date.now()
    }
    root.persist()
  }

  function undrainAll() {
    root.internal.drained = {}
    root.persist()
  }

  // The bar alert colour is the one surface that could nag forever: an install
  // with no token would hold it until a token arrived or the widget was removed.
  // Seeing the setup tile once is enough; the pill itself stays (it is the one
  // empty state that must not collapse), it just stops shouting.
  function markSetupSeen() {
    if (root.internal.setupSeen === true) return
    root.internal.setupSeen = true
    root.persist()
  }

  // ----------------------------------------------------------- persistence

  function persist() {
    root.queue = Model.applyDrained(root.allItems, root.internal.drained)
    // NO item rows. state.json is world readable in practice, because the one
    // thing that ever reads it is a human pasting it into a bug report, and the
    // queue carries private repository names and private pull request titles.
    // Lane counts answer every diagnostic question the file existed to answer
    // and disclose nothing. SECURITY.md documents exactly this shape.
    var c = Model.counts(root.queue, root.slaHours, Date.now())
    stateFile.setText(JSON.stringify({
      generatedAt: root.generatedAt,
      configured: root.configured,
      counts: {
        review: c.review, blocked: c.blocked, ready: c.ready,
        total: c.total, overdue: c.overdue,
        drained: Math.max(0, root.allItems.length - root.queue.length)
      },
      fetchNotice: root.fetchNotice,
      lastError: root.lastError,
      // The ONLY diagnostic surface a token is allowed: enough to tell a wrong
      // token from an expired one in a support thread, useless to anyone else.
      account: { login: root.login, last4: root.token.slice(-4) }
    }))
    internalFile.setText(JSON.stringify(root.internal))
    // A JS array mutated in place emits no change notification, so the panel
    // would render stale forever without this signal plus its revision bump.
    root.stateChanged()
  }

  function loadCredentials(raw) {
    var c
    try { c = JSON.parse(String(raw || "")) } catch (e) { c = null }
    if (c && c.token && c.login) {
      root.token = String(c.token)
      root.login = String(c.login)
    } else {
      root.token = ""
      root.login = ""
    }
    root.credsLoaded = true
    root.maybeStart()
  }

  function loadInternal(raw) {
    root.internal = Model.parseInternal(raw)
    root.stateLoaded = true
    root.maybeStart()
  }

  function maybeStart() {
    // Emit on BOTH the loaded and the load-failed path, so a panel that opened
    // before the first read still leaves its waiting state.
    if (!root.stateLoaded || !root.credsLoaded) { root.stateChanged(); return }
    root.readSettings()
    root.persist()
    root.poll()
  }

  // ------------------------------------------------------------------ procs

  Process {
    id: apiProc
    stdinEnabled: true

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.onApiResponse(text)
    }

    onStarted: {
      // The Authorization header goes over stdin so the token is never in an
      // argv. Setting stdinEnabled = false immediately after the single write
      // is not cleanup: it closes the pipe, and that EOF is what curl needs
      // before it will stop reading `@-` and actually issue the request.
      // Without it curl blocks until --max-time expires and the failure reads
      // as a flaky network rather than a bug.
      apiProc.write("Authorization: Bearer " + root.token + "\n")
      apiProc.stdinEnabled = false
    }

    onExited: function(code) {
      // A non-zero curl exit with empty stdout may never reach
      // onStreamFinished with a body. Without this branch the poll flag stays
      // true forever and the plugin dies quietly after one bad response.
      if (code !== 0 && root.polling) root.finishPoll("fetch failed", null)
    }
  }

  Process {
    id: notifyProc
    onExited: root.sendNextNotification()
  }

  // ------------------------------------------------------------- file views

  FileView {
    id: credsFile
    path: root.credsPath
    watchChanges: true
    printErrors: false
    onLoaded: root.loadCredentials(text())
    onLoadFailed: root.loadCredentials("")
    // Picking the token up on write is what makes docket-login take effect
    // without a shell restart. This view NEVER calls setText: the login helper
    // is the only writer of that file.
    onFileChanged: reload()
  }

  FileView {
    id: internalFile
    path: root.internalPath
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadInternal(text())
    onLoadFailed: root.loadInternal("")
  }

  FileView {
    id: stateFile
    path: root.statePath
    atomicWrites: true
    printErrors: false
  }

  FileView {
    id: shellConfigFile
    path: (Quickshell.env("XDG_CONFIG_HOME") || root.home + "/.config") + "/omarchy/shell.json"
    printErrors: false
    // Settings are edited in Omarchy's settings UI, which rewrites this file.
    // Without the watch, readSettings() only ran on the next poll, so a filter
    // toggle appeared to do nothing for up to 15 minutes.
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.onSettingsFileChanged()
  }

  Timer {
    interval: root.pollIntervalSec * 1000
    running: true
    repeat: true
    onTriggered: root.poll()
  }
}
