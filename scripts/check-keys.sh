#!/usr/bin/env bash
# Guard every artifact whose bytes ARE its identity against an unnoticed re-key.
#
#   delegate   key = BLAKE3(BLAKE3(wasm))  — the namespace every user's ante
#              identity is stored under. Moving it makes every identity
#              unreachable; each user must restore from their recovery code.
#   contracts  address = BLAKE3(BLAKE3(wasm) ‖ params) — moving it strands all
#              state at the old address: every guestbook entry, every published
#              identity level.
#
# What it takes to move one is not obvious. `panic!` / `expect` bake `line!()`
# into the binary, so a shifted line above one is enough — measured: adding a
# comment to ante-core/src/lib.rs re-keys the delegate, because the delegate
# calls `to_cbor` (whose `expect` lives near the top of that file) on every
# reply. The contracts survive the same edit only because they set
# `panic = "abort"` + `strip` and carry their own `cbor()` helper. That is a
# property to verify, not to assume.
#
#   ./scripts/check-keys.sh                         # verify (CI does this)
#   ANTE_ACCEPT_REKEY=1 ./scripts/check-keys.sh     # record a deliberate one
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECORD="$REPO_ROOT/artifact-keys.toml"

DELEGATE_WASM="$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm"
REGISTRY_WASM="$REPO_ROOT/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"
GUESTBOOK_WASM="$REPO_ROOT/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"

# ALWAYS build through the canonical script, never trust an artifact that
# happens to be lying in target/. A plain `cargo build` omits the
# --remap-path-prefix flags, so its output differs from the canonical one — and
# a hash taken from such a leftover is worse than no hash at all: it makes the
# guard disagree with what actually gets published. (This is not hypothetical;
# it is how the first recorded value for the guestbook came to be wrong.)
# Cargo no-ops when nothing changed, so this is cheap.
build() {
  echo "building $1…" >&2
  case "$1" in
    delegate)  "$REPO_ROOT/scripts/build-delegate.sh" >/dev/null ;;
    registry)  (cd "$REPO_ROOT/contracts/ante-registry" && "$REPO_ROOT/scripts/build-contract.sh" >/dev/null) ;;
    guestbook) (cd "$REPO_ROOT/examples/guestbook/contract" && "$REPO_ROOT/scripts/build-contract.sh" >/dev/null) ;;
  esac
}
build delegate
build registry
build guestbook

field() { echo "$1" | awk -v k="$2" '$1 == k {print $2}'; }
DELEGATE_INFO="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$DELEGATE_WASM")"
DELEGATE_CODE_HASH="$(field "$DELEGATE_INFO" code_hash_hex)"
DELEGATE_KEY="$(field "$DELEGATE_INFO" key_hex)"
REGISTRY_CODE_HASH="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$REGISTRY_WASM" | awk '$1=="code_hash_hex"{print $2}')"
GUESTBOOK_CODE_HASH="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$GUESTBOOK_WASM" | awk '$1=="code_hash_hex"{print $2}')"

if [ "${ANTE_ACCEPT_REKEY:-}" = "1" ]; then
  cat > "$RECORD" <<EOF
# Content addresses of everything whose bytes are its identity. GENERATED —
# update only via: ANTE_ACCEPT_REKEY=1 ./scripts/check-keys.sh
#
# A diff here is a BREAKING CHANGE. Say so in the release notes:
#   delegate  -> every identity is unreachable; users restore from their
#                recovery code (AnteClient.exportIdentity / importIdentity).
#   contract  -> all state at the old address is stranded (guestbook entries,
#                published identity levels).
#
# A contract's published instance is BLAKE3(code_hash ‖ params), so a stable
# code_hash here plus unchanged params means a stable address. The live
# instance ids are in DEPLOYMENTS.md.
[delegate]
code_hash = "$DELEGATE_CODE_HASH"
key = "$DELEGATE_KEY"

[contracts]
ante_registry_code_hash = "$REGISTRY_CODE_HASH"
guestbook_code_hash = "$GUESTBOOK_CODE_HASH"
EOF
  echo "recorded:"
  echo "  delegate key        $DELEGATE_KEY"
  echo "  ante-registry hash  $REGISTRY_CODE_HASH"
  echo "  guestbook hash      $GUESTBOOK_CODE_HASH"
  echo "commit artifact-keys.toml with the change that caused it."
  exit 0
fi

[ -f "$RECORD" ] || { echo "no record at $RECORD — create it with ANTE_ACCEPT_REKEY=1 $0" >&2; exit 1; }
recorded() { awk -F'"' -v k="$1" '$0 ~ "^"k" *=" {print $2}' "$RECORD"; }

status=0
compare() { # label recorded built consequence
  if [ "$2" = "$3" ]; then
    printf '  ✓ %-14s %s\n' "$1" "$3"
  else
    printf '  ✗ %-14s MOVED\n      was %s\n      now %s\n      %s\n' "$1" "$2" "$3" "$4" >&2
    status=1
  fi
}
echo "artifact keys:"
compare "delegate"      "$(recorded key)"                     "$DELEGATE_KEY"       "every stored identity becomes unreachable; users must restore from their recovery code"
compare "ante-registry" "$(recorded ante_registry_code_hash)" "$REGISTRY_CODE_HASH" "every published identity level is stranded at the old address"
compare "guestbook"     "$(recorded guestbook_code_hash)"     "$GUESTBOOK_CODE_HASH" "every guestbook entry is stranded at the old address"

if [ "$status" -ne 0 ]; then
  cat >&2 <<EOF

If that is intended, record it and say so in the release notes:

  ANTE_ACCEPT_REKEY=1 ./scripts/check-keys.sh

If it is NOT, look for an edit to ante-core or the artifact's own crate — a
shifted line above a panic! is enough to do this.
EOF
fi
exit "$status"
