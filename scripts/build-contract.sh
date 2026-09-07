#!/usr/bin/env bash
# Build a contract crate's WASM the one canonical way, from inside its
# directory.
#
# A contract's address IS its WASM bytes (`blake3(wasm ‖ params)`), so the
# build must not bake in machine-specific paths — `panic!` embeds `file!()` as
# rodata, and for the cargo registry that is an absolute path under
# $CARGO_HOME. Remap them to fixed placeholders and refuse the build if any
# leaked.
set -euo pipefail

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
CRATE_DIR="$(pwd)"
# The whole worktree, so a path dependency beside this crate (ante-core) is
# remapped too — remapping only $CRATE_DIR leaves its absolute path in rodata.
WORKTREE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  --remap-path-prefix=$WORKTREE_DIR=/ante \
  --remap-path-prefix=$CRATE_DIR=/crate"

cargo build --target wasm32-unknown-unknown --release "$@"

WASM="$(find target/wasm32-unknown-unknown/release -maxdepth 1 -name '*.wasm' -print -quit)"
[ -n "$WASM" ] || { echo "no .wasm produced" >&2; exit 1; }

# No wasm-opt: a contract's address is its bytes, and "which binaryen version"
# is a machine dependency the address must not carry. See build-delegate.sh.

echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"
command -v b3sum >/dev/null 2>&1 && echo "code_hash: $(b3sum --no-names "$WASM")"

for leak in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$WORKTREE_DIR" "$CRATE_DIR" "$HOME"; do
  if grep -a -q -F "$leak" "$WASM"; then
    echo "ERROR: '$leak' is embedded in the WASM — the contract id would be machine-specific." >&2
    exit 1
  fi
done
