# Changelog

Notable changes to Docket.

Entries are derived from this repository's commit history, so every line
corresponds to a real change. The format follows Keep a Changelog and the
project uses Semantic Versioning.

Regenerate with `scripts/gen-changelog.sh`.

## [Unreleased]

Nothing yet.

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

