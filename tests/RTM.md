# Requirements Traceability Matrix: Docket

| ID | Priority | Requirement | Layers | Evidence |
|---|---|---|---|---|
| REQ-DOC-001 | MUST | Classify review requests, blocked own work, and ready-to-merge work deterministically and oldest first | L3, L4 | `tests/model.test.js`, render fixture test |
| REQ-DOC-002 | MUST | Draining hides a PR only until its `updatedAt` changes | L3, L7 | `tests/model.test.js` |
| REQ-DOC-003 | MUST | Network strings are sanitized, bounded, plain text, and never become unsafe shell input | L3, L5 | `tests/model.test.js`, `tests/a11y.test.js` |
| REQ-DOC-004 | MUST | Credentials never enter argv and publication is descriptor-bound, private, and race resistant | L2, L5 | `tests/credential-helper.test.js`, `bin/docket-login`, `bin/docket-secure-state` |
| REQ-DOC-005 | MUST | The QML panel calls only exported model functions and all plugin entry points resolve | L4, L6 | `tests/contract.test.js` |
| REQ-DOC-006 | MUST | The panel supports pointer and keyboard operation with a visible, named action model | L5, L7 | `tests/a11y.test.js`, Buzz journey |
| REQ-DOC-007 | MUST | The listing uses the full description allowance, a unique Docket banner, and a provenance-bound populated preview | L6, L7 | `tests/contract.test.js`, `assets/banner.svg`, `.render-proof.json` |
| REQ-DOC-008 | MUST | Exact clean source passes validator, qmllint, live shell load, and the real poll-to-panel fixture flow | L6, L7 | `e2e/buzz.sh`, `.rig-proof.json`, `.render-proof.json` |
