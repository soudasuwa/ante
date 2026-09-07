#!/usr/bin/env bash
# Print the keys of the WASM already sitting in the target directories, in the
# `artifact = value` form artifact-keys.toml records.
#
# Deliberately does NOT build. check-keys.sh builds and compares; this only
# reports, so it can be the last step of a container image whose whole job was
# the build. Keeping the two apart also means the container's answer cannot be
# quietly influenced by a rebuild that happens at print time.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DELEGATE_WASM="$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm"
REGISTRY_WASM="$REPO_ROOT/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"
GUESTBOOK_WASM="$REPO_ROOT/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"

for w in "$DELEGATE_WASM" "$REGISTRY_WASM" "$GUESTBOOK_WASM"; do
  [ -f "$w" ] || { echo "missing $w — build first" >&2; exit 1; }
done

info() { cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$1"; }
field() { echo "$1" | awk -v k="$2" '$1 == k {print $2}'; }

D="$(info "$DELEGATE_WASM")"
echo "delegate       $(field "$D" key_hex)"
echo "delegate_code  $(field "$D" code_hash_hex)"
echo "ante-registry  $(field "$(info "$REGISTRY_WASM")" code_hash_hex)"
echo "guestbook      $(field "$(info "$GUESTBOOK_WASM")" code_hash_hex)"
