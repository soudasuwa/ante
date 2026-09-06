//! Print the Freenet delegate `code_hash` and lookup `key` for a WASM file.
//!
//!   code_hash = blake3(wasm_bytes)
//!   key       = blake3(code_hash || parameters)
//!
//! The ante delegate takes no parameters, so `parameters` is empty. Matches
//! `freenet_stdlib::delegate_interface::{CodeHash::from_code, generate_id}`.
//!
//! Usage: `delegate-key <path-to.wasm>`
//!
//! Output (stdout), one `name value` pair per line — consumers match the name
//! exactly, so new lines can be added without breaking them:
//!
//! ```text
//! code_hash     [12,34,...]   json array, for embedding in TypeScript
//! key           [56,78,...]
//! code_hash_hex 0c22...       hex, for the committed key record
//! key_hex       384e...
//! ```

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: delegate-key <path-to.wasm>");
        return ExitCode::FAILURE;
    };
    let wasm = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let code_hash = blake3::hash(&wasm);
    let key = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(code_hash.as_bytes());
        // parameters: empty
        *hasher.finalize().as_bytes()
    };

    println!("code_hash {}", json_array(code_hash.as_bytes()));
    println!("key {}", json_array(&key));
    println!("code_hash_hex {}", hex(code_hash.as_bytes()));
    println!("key_hex {}", hex(&key));
    ExitCode::SUCCESS
}

fn json_array(bytes: &[u8]) -> String {
    let inner: Vec<String> = bytes.iter().map(|b| b.to_string()).collect();
    format!("[{}]", inner.join(","))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
