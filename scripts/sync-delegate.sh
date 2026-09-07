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

# Report a re-key rather than failing: local iteration on the delegate re-keys
# on every edit, and that is expected. CI runs the same check as a hard gate,
# so a re-key cannot reach main without someone recording it deliberately.
if ! "$REPO_ROOT/scripts/check-keys.sh"; then
  echo
  echo "  ^^ the delegate key moved. Fine while iterating; before you publish,"
  echo "     run  ANTE_ACCEPT_REKEY=1 ./scripts/check-keys.sh  and commit"
  echo "     the record, and tell users to save their recovery code first."
  echo
fi

"$REPO_ROOT/scripts/gen-embedded.sh" "$WASM"

echo
echo "next: npm run dev --workspace web"
