use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

/* ------------------------------- bitfield -------------------------------- */

/// Which pieces of a file a node holds. Packed MSB-first for the wire.
#[derive(Clone)]
pub struct Bitfield {
    pub(super) bits: Vec<bool>,
}

impl Bitfield {
    pub(super) fn empty(n: usize) -> Self {
        Self {
            bits: vec![false; n],
        }
    }
    pub(super) fn full(n: usize) -> Self {
        Self {
            bits: vec![true; n],
        }
    }
    pub(super) fn set(&mut self, i: usize) {
        if let Some(b) = self.bits.get_mut(i) {
            *b = true;
        }
    }
    pub(super) fn get(&self, i: usize) -> bool {
        self.bits.get(i).copied().unwrap_or(false)
    }
    pub(super) fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }
    pub(super) fn is_complete(&self) -> bool {
        !self.bits.is_empty() && self.bits.iter().all(|b| *b)
    }
    /// Packed bytes (MSB-first), base64-encoded for `swarm-bitfield`.
    pub(super) fn to_base64(&self) -> String {
        let mut bytes = vec![0u8; self.bits.len().div_ceil(8)];
        for (i, b) in self.bits.iter().enumerate() {
            if *b {
                bytes[i / 8] |= 0x80 >> (i % 8);
            }
        }
        BASE64.encode(bytes)
    }
    pub(super) fn from_base64(s: &str, n: usize) -> Self {
        let mut bf = Self::empty(n);
        if let Ok(bytes) = BASE64.decode(s) {
            for i in 0..n {
                if bytes
                    .get(i / 8)
                    .map(|b| b & (0x80 >> (i % 8)) != 0)
                    .unwrap_or(false)
                {
                    bf.bits[i] = true;
                }
            }
        }
        bf
    }
}
