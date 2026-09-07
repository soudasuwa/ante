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
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
WORKTREE_DIR="$REPO_ROOT"

# Appended so a caller's RUSTFLAGS still apply — though setting your own means a
# different hash. The canonical build is this script with nothing extra set.
#
# All three prefixes, matching build-contract.sh. Remapping only the cargo
# registry (as this did until the guard caught it) still let
# $RUSTUP_HOME/toolchains/.../library/std/... through, so the delegate carried
# the builder's home directory and no two machines agreed on its key.
#
# The third is the whole worktree, not just this crate: the delegate links
# ante-core, which sits beside it, and `to_cbor`'s expect() puts
# ante-core/src/lib.rs into rodata. Remapping only $DELEGATE_DIR left that
# absolute path behind — the same file whose line numbers already re-key this
# artifact.
# The toolchain's own sysroot, remapped FIRST so it wins over the broader
# $RUSTUP_HOME rule below. Remapping only $RUSTUP_HOME leaves the toolchain
# DIRECTORY NAME in the path — /rustup/toolchains/stable-x86_64-.../library/std
# versus /rustup/toolchains/1.98.1-x86_64-.../library/std — so the very same
# compiler, installed twice under two names, produced two different artifacts
# and two different keys. rust-toolchain.toml pins the version but not the name
# it is installed under, and `stable` resolving to the pinned version is the
# normal case on a developer machine, so this was reachable by anyone.
SYSROOT_DIR="$(rustc --print sysroot)"

# NOTE the order: rustc applies the LAST matching --remap-path-prefix, not the
# first, so the narrow sysroot rule has to come AFTER the broad $RUSTUP_HOME one
# or it never takes effect. Putting it first looked right and changed nothing.
export RUSTFLAGS="${RUSTFLAGS:-} \
  --remap-path-prefix=$CARGO_HOME_DIR/registry/src=/cargo-registry \
  --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup \
  --remap-path-prefix=$SYSROOT_DIR=/rust-sysroot \
  --remap-path-prefix=$WORKTREE_DIR=/ante"

cargo build --target wasm32-unknown-unknown --release "$@"

WASM="target/wasm32-unknown-unknown/release/ante_delegate.wasm"

echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"
if command -v b3sum >/dev/null 2>&1; then
    echo "code_hash: $(b3sum --no-names "$WASM")"
fi

# Fail loudly rather than ship a machine-specific binary. Check every prefix we
# remap, not just the cargo registry — the missing $RUSTUP_HOME check is exactly
# how a leak survived here unnoticed.
for leak in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$WORKTREE_DIR" "$HOME"; do
    if grep -a -q -F "$leak" "$WASM"; then
        echo "ERROR: '$leak' is embedded in the WASM." >&2
        echo "This build is machine-specific and must not be published — the delegate" >&2
        echo "key would be one nobody else can recompute." >&2
        exit 1
    fi
done
