#!/usr/bin/env bash
# Build the ante delegate WASM the one canonical way.
#
# The delegate key is BLAKE3(BLAKE3(wasm) || params), so any byte that changes
# in the WASM moves every stored identity to a new namespace. "Which bytes does
# this source produce" is therefore a correctness question, and the answer must
# not depend on the machine.
#
# Two things make the build reproducible; only the second is this script's job:
#
#   1. ante-delegate/Cargo.lock is committed. Two checkouts of one commit must
#      resolve identical dependency versions.
#   2. Dependency source paths are baked into the binary by `panic!` (`file!()`
#      lands in rodata and survives `strip`). This remaps the registry prefix
#      to a fixed placeholder so a laptop and a CI runner agree.
#
# `-Ztrim-paths` would be tidier but is not stable. Remap by hand.
#
# NOT run through wasm-opt: it is deterministic only for a fixed version, and
# "is binaryen installed, which version" is exactly the machine dependency the
# delegate key must not have. The ~50 KB it would save is not worth a key that
# splits by toolchain. If size ever matters, pin a wasm-opt version and make it
# a required step, not an optional one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DELEGATE_DIR="$REPO_ROOT/ante-delegate"
cd "$DELEGATE_DIR"

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"

# Appended so a caller's RUSTFLAGS still apply — though setting your own means a
# different hash. The canonical build is this script with nothing extra set.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$CARGO_HOME_DIR/registry/src=/cargo-registry"

cargo build --target wasm32-unknown-unknown --release "$@"

WASM="target/wasm32-unknown-unknown/release/ante_delegate.wasm"

echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"
if command -v b3sum >/dev/null 2>&1; then
    echo "code_hash: $(b3sum --no-names "$WASM")"
fi

# Fail loudly rather than ship a machine-specific binary.
LEAKED="$(grep -a -c -F "$CARGO_HOME_DIR" "$WASM" || true)"
if [ "${LEAKED:-0}" -ne 0 ]; then
    echo "ERROR: absolute path(s) from $CARGO_HOME_DIR are embedded in the WASM." >&2
    echo "This build is machine-specific and must not be published — the delegate" >&2
    echo "key would be one nobody else can recompute." >&2
    exit 1
fi
