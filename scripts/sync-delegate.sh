#!/usr/bin/env bash
# Build the ante delegate and embed it in @ante/client.
#
# Runs the canonical WASM build and regenerates client/src/embedded.ts (base64
# WASM + address). Re-run whenever the delegate source changes; every consumer
# of @ante/client then picks it up.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm"

"$REPO_ROOT/scripts/build-delegate.sh"
"$REPO_ROOT/scripts/gen-embedded.sh" "$WASM"

echo
echo "next: (cd web && npm run dev)"
