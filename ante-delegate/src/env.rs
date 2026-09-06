//! A thin seam over the delegate host functions.
//!
//! `DelegateCtx`'s secret store, scratch context, and entropy source are all
//! WASM-only — off-target they are inert stubs. Routing every host touch
//! through this trait lets the delegate's real logic (key custody, the consent
//! round-trip) run under `cargo test` against an in-memory double.

use freenet_stdlib::prelude::DelegateCtx;

/// Everything the delegate needs from the host.
pub trait DelegateEnv {
    /// Read a persistent encrypted secret.
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>>;
    /// Write a persistent encrypted secret. `false` on failure.
    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool;

    /// Read the per-message scratch context (empty if unset). This is where a
    /// pending consent prompt is parked between the `RequestUserInput` and the
    /// `UserResponse` that answers it; the host clears it after a short TTL.
    fn context_read(&self) -> Vec<u8>;
    /// Replace the scratch context. `false` on failure.
    fn context_write(&mut self, data: &[u8]) -> bool;
    /// Clear the scratch context.
    fn context_clear(&mut self) -> bool {
        self.context_write(&[])
    }

    /// `n` bytes from the host CSPRNG. Used once, at identity creation.
    fn rand_bytes(&self, n: usize) -> Vec<u8>;
}

impl DelegateEnv for DelegateCtx {
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>> {
        DelegateCtx::get_secret(self, key)
    }
    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool {
        DelegateCtx::set_secret(self, key, value)
    }
    fn context_read(&self) -> Vec<u8> {
        self.read()
    }
    fn context_write(&mut self, data: &[u8]) -> bool {
        self.write(data)
    }
    fn rand_bytes(&self, n: usize) -> Vec<u8> {
        freenet_stdlib::rand::rand_bytes(n as u32)
    }
}

/// In-memory `DelegateEnv` for native tests.
#[cfg(test)]
pub struct TestEnv {
    secrets: std::collections::HashMap<Vec<u8>, Vec<u8>>,
    context: Vec<u8>,
    /// Deterministic entropy handed to the next `rand_bytes` call. Non-zero so
    /// the "host entropy failed" guard in key creation does not trip.
    entropy: Vec<u8>,
    fail_next_context_write: bool,
    fail_next_set_secret: bool,
}

#[cfg(test)]
impl TestEnv {
    pub fn new() -> Self {
        Self {
            secrets: std::collections::HashMap::new(),
            context: Vec::new(),
            entropy: vec![0x11; 64],
            fail_next_context_write: false,
            fail_next_set_secret: false,
        }
    }

    pub fn with_entropy(mut self, entropy: Vec<u8>) -> Self {
        self.entropy = entropy;
        self
    }

    pub fn fail_next_context_write(&mut self) {
        self.fail_next_context_write = true;
    }

    pub fn fail_next_set_secret(&mut self) {
        self.fail_next_set_secret = true;
    }

    pub fn context_is_empty(&self) -> bool {
        self.context.is_empty()
    }
}

#[cfg(test)]
impl DelegateEnv for TestEnv {
    fn get_secret(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.secrets.get(key).cloned()
    }
    fn set_secret(&mut self, key: &[u8], value: &[u8]) -> bool {
        if std::mem::take(&mut self.fail_next_set_secret) {
            return false;
        }
        self.secrets.insert(key.to_vec(), value.to_vec());
        true
    }
    fn context_read(&self) -> Vec<u8> {
        self.context.clone()
    }
    fn context_write(&mut self, data: &[u8]) -> bool {
        if std::mem::take(&mut self.fail_next_context_write) {
            return false;
        }
        self.context = data.to_vec();
        true
    }
    fn rand_bytes(&self, n: usize) -> Vec<u8> {
        let mut out = self.entropy.clone();
        out.resize(n, 0);
        out
    }
}
