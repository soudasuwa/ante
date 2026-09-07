#!/usr/bin/env bash
# Run Freenet's own merge verifier against both contracts.
#
# A contract whose merge is not associative, commutative and idempotent cannot
# converge: two peers given the same updates in different orders end up with
# different state and retry forever. `fdev verify-merge` runs the same checker
# the network runs, so a finding here means exactly what it would mean live.
#
# Runs in CI (the `merge-laws` job installs fdev). Kept runnable by hand too,
# because a finding is much easier to read locally. The in-crate merge-law tests
# (ante-core::registry) cover the same properties on the Rust types; this checks
# the compiled WASM with the verifier the network itself uses.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v fdev >/dev/null || { echo "fdev not found — https://freenet.org/install.sh" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
status=0

check() { # name crate-dir wasm-name params-cmd
  local name="$1" dir="$2" wasm="$3"; shift 3
  echo "== $name =="
  (cd "$REPO_ROOT/$dir" && "$REPO_ROOT/scripts/build-contract.sh" >/dev/null)
  (cd "$REPO_ROOT/$dir" && cargo run -q --example dump_states -- "$work/$name" >/dev/null)
  "$@" > "$work/$name.params"

  local states=()
  for f in "$work/$name"/*.bin; do states+=(--state "$f"); done

  fdev verify-merge \
    --wasm "$REPO_ROOT/$dir/target/wasm32-unknown-unknown/release/$wasm" \
    --params "$work/$name.params" \
    "${states[@]}" \
    --transition "$work/$name/one.bin" "$work/$name/two.bin" \
    2>/dev/null | grep -E "merge check:|findings:|^  \[|no enforceable|violation" || true

  fdev verify-merge \
    --wasm "$REPO_ROOT/$dir/target/wasm32-unknown-unknown/release/$wasm" \
    --params "$work/$name.params" "${states[@]}" 2>/dev/null \
    | grep -q "no enforceable violations found" || { echo "  ENFORCEABLE VIOLATIONS in $name" >&2; status=1; }
  echo
}

emit_registry_params() {
  cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
    --purpose "ante:identity-level:v2" --floor 12 --out /dev/stdout 2>/dev/null || true
}

# registry-params/--out writes to a path; use a temp file and cat it.
reg_params() { local f; f="$(mktemp)"; cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- --purpose "ante:identity-level:v2" --floor 12 --out "$f" >/dev/null; cat "$f"; rm -f "$f"; }
gb_params()  { local f; f="$(mktemp)"; (cd "$REPO_ROOT/examples/guestbook/contract" && cargo run -q --example params -- --purpose "ante-guestbook:post:v2" --min-bits 16 --out "$f" >/dev/null); cat "$f"; rm -f "$f"; }

check ante-registry contracts/ante-registry ante_registry_contract.wasm reg_params
check guestbook examples/guestbook/contract ante_guestbook_contract.wasm gb_params

exit "$status"
