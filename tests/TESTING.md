# Testing Policy: Docket

## Classification

Repo type: frontend and CLI (Omarchy QML plugin, offline JavaScript model, secure credential helper)
Primary languages: QML, JavaScript ES5, Bash, Perl
Applicable layers: L1, L2, L3, L4-contract, L5-security, L5-a11y, L6-e2e, L6-visual, L7-acceptance
Waived layers: L4-migration until the persisted schema changes

## Thresholds

coverage.line: 95
coverage.branch: 88
coverage.function: 95
mutation.kill_rate: 90
flaky.tolerance: 0/3runs
personas.flow_coverage_min: 100
journeys.step_coverage_min: 100

## Required gates

- L1: manifest-verified current Omarchy gate lane and pinned GitHub Actions.
- L2: ShellCheck, manifest validation, audit-harness, and runtime dependency checks.
- L3: node:test, c8 coverage, Stryker mutation, and three repeated concurrent runs.
- L4: QML-to-Model exports, manifest entry points, service identity, and fixture contracts.
- L5: descriptor-bound credential publication with hostile-race tests, bounded plain text, keyboard access, and named pointer controls.
- L6: Buzz validator, qmllint, real shell load, real service parse/classify flow, IPC toggle, primary-action assertion, and uncropped preview.
- L7: the maintainer, reviewer, and Omarchy-user journeys below.

## Installed gates

- L1/L2: pinned GitHub Actions, ShellCheck, npm audit, audit-harness, and canonical C28-C43.
- L3: 99 node tests, c8 thresholds, three concurrent repetitions, and Stryker at a 90% break floor.
- L4/L5: manifest/QML/model contracts, accessibility assertions, exact presentation contracts, and
  descriptor-bound credential publication under symlink, FIFO, replacement, and parent-swap attacks.
- L6/L7: scrubbed three-lane fixture, isolated Buzz launcher, direct full-frame render proof, IPC panel
  toggle and drain action, plus persona, journey, and requirements traceability documents.

The Buzz render and acceptance scripts deliberately require a clean committed source SHA. They are
the post-commit release lane and cannot be replaced by a locally fabricated screenshot.

## Last audit

2026-08-29 baseline and post-remediation evidence recorded in `TEST_AUDIT.md`.
