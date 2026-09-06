#!/usr/bin/env bash
# Build the delegate and stage it for the web UI.
#
# Runs the canonical WASM build, computes the delegate code_hash and key, and
# writes web/.gen/ — the files vite.config.ts reads to inline the WASM and its
# address into the UI bundle. Re-run this whenever the delegate source changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$REPO_ROOT/web/.gen"
WASM="$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm"

"$REPO_ROOT/scripts/build-delegate.sh"

mkdir -p "$GEN"
cp "$WASM" "$GEN/ante_delegate.wasm"

KEYINFO="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$WASM")"
echo "$KEYINFO" | awk '/^code_hash/ {print $2}' > "$GEN/ante_delegate_code_hash_bytes.json"
echo "$KEYINFO" | awk '/^key/ {print $2}'       > "$GEN/ante_delegate_key_bytes.json"

echo "staged:"
echo "  $GEN/ante_delegate.wasm  ($(wc -c < "$GEN/ante_delegate.wasm") bytes)"
echo "  code_hash: $(cat "$GEN/ante_delegate_code_hash_bytes.json")"
echo "  key:       $(cat "$GEN/ante_delegate_key_bytes.json")"
echo
echo "next: (cd web && npm run dev)"
