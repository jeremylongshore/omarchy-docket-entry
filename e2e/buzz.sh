#!/usr/bin/env bash
# Acceptance lane: static rig checks plus populated live service, panel, visual,
# and drain-action evidence on the production Buzz Omarchy container.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/rig-verify.sh" "$ROOT"
"$ROOT/scripts/rig-render.sh" "$ROOT" "$ROOT/preview.png"
test -s "$ROOT/preview.png"
jq -e '.sourceDirty == false and .sourcePackageSha256 == .remotePackageSha256' \
  "$ROOT/.rig-proof.json" >/dev/null
jq -e '.sourceDirty == false and .sourcePackageSha256 == .remotePackageSha256
  and (.previewSha256 | length == 64) and .dimensions == "1280 x 720"
  and .nonblackCoverage >= 0.35 and (.runId | length > 0)
  and (.rawShellLogSha256 | length == 64)
  and .storyEvidence.laneCount == 3 and .storyEvidence.rowCount == 6
  and .storyEvidence.allPrimaryRowsExpected == true and .outputScale == 1.25
  and .visualInspection.status == "pending"
  and .primaryAction == "oldest selected pull request drained and persisted by the live panel"' \
  "$ROOT/.render-proof.json" >/dev/null
