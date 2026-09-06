#!/usr/bin/env bash
# Guard the delegate's identity against an unnoticed re-key.
#
# The delegate key is BLAKE3(BLAKE3(wasm)) and it is the namespace every user's
# ante identity is stored under on their node. Move it and every existing
# identity goes invisible — the delegate cannot tell, so it silently mints a new
# one and the user's level is gone.
#
# The trap is how *little* it takes. `panic!` / `expect` bake `line!()` into the
# binary, so adding a comment line above one in `ante-core` is enough. That is
# not a hypothetical: it is how this check came to exist.
#
# So the key is a committed fact (ante-delegate/delegate-key.toml) and this
# script fails when the build disagrees with it. A re-key then shows up as a
# reviewable diff instead of a support ticket.
#
#   ./scripts/check-delegate-key.sh                 # verify (CI does this)
#   ANTE_ACCEPT_REKEY=1 ./scripts/check-delegate-key.sh   # record a deliberate one
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="${1:-$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm}"
RECORD="$REPO_ROOT/ante-delegate/delegate-key.toml"

[ -f "$WASM" ] || { echo "no delegate WASM at $WASM — run scripts/build-delegate.sh first" >&2; exit 1; }

INFO="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p delegate-key -- "$WASM")"
BUILT_CODE_HASH="$(echo "$INFO" | awk '$1 == "code_hash_hex" {print $2}')"
BUILT_KEY="$(echo "$INFO" | awk '$1 == "key_hex" {print $2}')"

write_record() {
  cat > "$RECORD" <<EOF
# The delegate's identity, as a committed fact. GENERATED — update it only by
# running: ANTE_ACCEPT_REKEY=1 ./scripts/check-delegate-key.sh
#
# \`key\` is the namespace every user's ante identity lives under on their node.
# When it changes, those identities become unreachable and each user has to
# restore from their recovery code (AnteClient.exportIdentity / importIdentity).
#
# It changes on ANY change to the delegate's compiled bytes — including an edit
# to ante-core that only shifts a line number above a \`panic!\`, because
# \`line!()\` is baked into the binary. Treat a diff here as a breaking change:
# say so in the release notes and tell users to save their recovery code first.
code_hash = "$BUILT_CODE_HASH"
key = "$BUILT_KEY"
EOF
}

if [ "${ANTE_ACCEPT_REKEY:-}" = "1" ]; then
  write_record
  echo "recorded delegate key: $BUILT_KEY"
  echo "commit ante-delegate/delegate-key.toml with the change that caused it."
  exit 0
fi

if [ ! -f "$RECORD" ]; then
  echo "no key record at $RECORD" >&2
  echo "create it with: ANTE_ACCEPT_REKEY=1 ./scripts/check-delegate-key.sh" >&2
  exit 1
fi

RECORDED_KEY="$(awk -F'"' '/^key *=/ {print $2}' "$RECORD")"

if [ "$BUILT_KEY" = "$RECORDED_KEY" ]; then
  echo "delegate key unchanged: $BUILT_KEY"
  exit 0
fi

cat >&2 <<EOF
ERROR: the delegate key moved.

  recorded  $RECORDED_KEY
  built     $BUILT_KEY

Every ante identity stored under the recorded key becomes unreachable on
upgrade; users must restore from their recovery code. If that is intended,
record it deliberately:

  ANTE_ACCEPT_REKEY=1 ./scripts/check-delegate-key.sh

and commit ante-delegate/delegate-key.toml alongside the change, noting it in
the release notes. If it is NOT intended, look for an edit to ante-core or
ante-delegate — a shifted line above a panic! is enough to do this.
EOF
exit 1
