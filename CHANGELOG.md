# Changelog

Notable changes to Docket.

Entries are derived from this repository's commit history, so every line
corresponds to a real change. The format follows Keep a Changelog and the
project uses Semantic Versioning.

Regenerate with `scripts/gen-changelog.sh`.

## [Unreleased]

Nothing yet.

## [1.1.0] - 2026-08-29

### Security

- Publish and forget credentials through a descriptor-bound helper that rejects symlinks, parent swaps, FIFOs, oversized input, and same-UID replacement races.
- Pin every CI action and make gate freshness fail closed.

### Added

- Add a 500-character marketplace story, a Docket-specific SVG banner, and hash-bound full-frame Buzz render evidence.
- Add coverage, mutation, race, accessibility, contract, fixture, and acceptance-journey tests.
- Exercise the unchanged service parse, classify, persist, panel-open, and drain paths in the isolated Omarchy shell.

### Fixed

- Preserve legacy boolean drain records by re-stamping them instead of expiring them as timestamp `1`.
- Prevent the shell-settings callback from cancelling Docket's initial persisted-record read and
  leaving the service permanently unconfigured.
- Repair the committed changelog generator conflict and restore a valid deterministic script.

## [1.0.0] - 2026-08-22

### Security

- Hot-load the credential, bound the panel, and add the rig receipt
- Pass the token to jq through stdin, never through argv

### Added

- Add a GitHub pull-request review queue for the Omarchy bar

### Internal

Tooling and repository changes with no effect on the shipped plugin.

- Vendor the submission gate lane, CI and a pre-push hook
- Vendor c38 and widen the rig fingerprint to cover shipped .js
- Pin the vendored lane to a manifest and refuse to run it unverified
- Re-sync the vendored lane and add an advisory freshness check
- Vendor c40, the panel design gate, and repair the sync that dropped it
- Vendor rig-render, which loads the plugin into a real shell
- Add four-lane MiniMax review and backfill the changelog
