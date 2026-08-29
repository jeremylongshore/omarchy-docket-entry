# Docket Test Audit

Audit date: 2026-08-29

Grade before remediation: C (64/100)

Classification: frontend and CLI; QML, ES5 JavaScript, Bash, and Perl.

## Baseline evidence

- 81/81 model tests passed.
- Model coverage was 99.66% lines, 88.00% branches, and 100% functions.
- The vendored plugin lane passed only 9 legacy checks and omitted C41-C43.
- Current canonical C41 blocked the credential pathname lifecycle.
- Current canonical C43 blocked the 249-character description, missing SVG banner, and missing render proof.

## Gaps handed to implement-tests

| Priority | Layer | Gap |
|---|---|---|
| P0 | L1/L2 | Vendored lane omitted current state-security, resource-budget, and marketplace-presentation gates. |
| P0 | L5 | Credential publication used pathname-based mktemp and rename without descriptor-bound hostile-race evidence. |
| P0 | L6/L7 | No isolated populated Buzz journey or hash-bound 16:9 marketplace preview. |
| P1 | L3 | No enforced coverage, mutation, or repeated-concurrency lane. |
| P1 | L4/L5 | No executable QML-model contract or accessibility assertions. |
| P1 | L7 | No RTM, persona, or acceptance-journey traceability. |

Escape scan: no threshold downgrade, test deletion, architecture weakening, or mutation bypass found.

This report records the pre-remediation baseline. Final release authority comes from the clean post-implementation test, gate, mutation, and Buzz evidence, not this grade.

## Post-remediation evidence

Implementation grade before the source commit and Buzz receipt: A (96/100), conditional only on the
required clean-commit render journey.

- 99/99 tests pass, including hostile same-UID credential races and the scrubbed three-lane fixture.
- Coverage is 100% statements, 100% lines, 100% functions, and 98.57% branches.
- Three concurrent full-suite repetitions pass with zero flakes.
- Mutation score is 92.61% across 1,150 mutants: 1,053 killed, 12 timed out as detected failures,
  85 survived, and zero lacked coverage. The enforced release floor remains 90%.
- `npm audit` reports zero vulnerabilities; audit-harness integrity, CRAP, secrets, links, unit, and
  E2E checks pass.
- Shell syntax and ShellCheck error/warning classes pass across shipped scripts and the vendored lane.
- Canonical gates C28-C42 pass. C43 correctly blocks until the clean source commit is rendered in
  Buzz and its direct full-frame preview receives a hash-bound `.render-proof.json` receipt.

Audit-harness reports advisory presence gaps for accessibility and contract tooling because version
1.3.1 recognizes axe/Pact packages but not QML `Accessible` assertions or JavaScript-to-QML contract
tests. The applicable tests are implemented in `tests/a11y.test.js` and `tests/contract.test.js`; no
irrelevant web dependency was installed to manipulate the heuristic. OSV and markdownlint remain
advisory on this runner because those binaries are absent; npm's lockfile vulnerability audit is clean.

The C43 block is intentional sequencing, not a waiver: render evidence is valid only after the source
commit is clean and immutable. Release authority remains fail closed until C43 and `e2e/buzz.sh` pass.
