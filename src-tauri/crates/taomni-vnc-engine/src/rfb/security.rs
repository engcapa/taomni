use super::*;

pub(super) struct RsaAesIo {
    pub(super) input: AesEax,
    pub(super) output: Option<AesEax>,
    pub(super) read_buf: VecDeque<u8>,
}

impl RsaAesIo {
    pub(super) fn new(input: AesEax, output: AesEax) -> Self {
        Self {
            input,
            output: Some(output),
            read_buf: VecDeque::new(),
        }
    }

    pub(super) fn read_exact(
        &mut self,
        stream: &mut TcpStream,
        buf: &mut [u8],
    ) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < buf.len() {
            if self.read_buf.is_empty() {
                let msg = rsa_aes_read_message(stream, &mut self.input)?;
                self.read_buf.extend(msg);
                if self.read_buf.is_empty() {
                    continue;
                }
            }

            let n = (buf.len() - offset).min(self.read_buf.len());
            for (dst, src) in buf[offset..offset + n]
                .iter_mut()
                .zip(self.read_buf.drain(..n))
            {
                *dst = src;
            }
            offset += n;
        }
        Ok(())
    }

    pub(super) fn write_all(&mut self, stream: &mut TcpStream, buf: &[u8]) -> std::io::Result<()> {
        let output = self.output.as_mut().ok_or_else(|| {
            Error::new(
                ErrorKind::BrokenPipe,
                "secure VNC output writer has already been split",
            )
        })?;
        for chunk in buf.chunks(RA2_AES_FRAME_MAX) {
            rsa_aes_write_message(stream, output, chunk)?;
        }
        Ok(())
    }

    pub(super) fn take_output(&mut self) -> Option<AesEax> {
        self.output.take()
    }
}

pub(super) enum AesKey {
    Aes128(aes::Aes128),
    Aes256(aes::Aes256),
}

pub(super) struct AesEax {
    pub(super) key: AesKey,
    pub(super) counter: [u8; 16],
}

impl AesEax {
    pub(super) fn new(key: &[u8]) -> Result<Self, String> {
        use aes::cipher::KeyInit;

        let key = match key.len() {
            16 => AesKey::Aes128(
                aes::Aes128::new_from_slice(key)
                    .map_err(|e| format!("AES-128 init failed: {}", e))?,
            ),
            32 => AesKey::Aes256(
                aes::Aes256::new_from_slice(key)
                    .map_err(|e| format!("AES-256 init failed: {}", e))?,
            ),
            _ => return Err(format!("unsupported AES key length {}", key.len())),
        };

        Ok(Self {
            key,
            counter: [0u8; 16],
        })
    }

    pub(super) fn encrypt_packet(&mut self, ad: &[u8], plaintext: &[u8]) -> (Vec<u8>, [u8; 16]) {
        let (ciphertext, tag) = self.eax_encrypt(&self.counter, ad, plaintext);
        increment_le(&mut self.counter);
        (ciphertext, tag)
    }

    pub(super) fn decrypt_packet(
        &mut self,
        ad: &[u8],
        ciphertext: &[u8],
        tag: &[u8],
    ) -> Result<Vec<u8>, String> {
        let expected = self.eax_tag(&self.counter, ad, ciphertext);
        if tag != expected {
            return Err("AES-EAX tag mismatch".to_string());
        }
        let plaintext = self.eax_decrypt(&self.counter, ciphertext);
        increment_le(&mut self.counter);
        Ok(plaintext)
    }

    pub(super) fn eax_encrypt(
        &self,
        nonce: &[u8; 16],
        ad: &[u8],
        plaintext: &[u8],
    ) -> (Vec<u8>, [u8; 16]) {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let mut ciphertext = plaintext.to_vec();
        self.ctr_xor(&nonce_mac, &mut ciphertext);
        let message_mac = self.omac(2, &ciphertext);
        (ciphertext, xor3(&nonce_mac, &header_mac, &message_mac))
    }

    pub(super) fn eax_decrypt(&self, nonce: &[u8; 16], ciphertext: &[u8]) -> Vec<u8> {
        let nonce_mac = self.omac(0, nonce);
        let mut plaintext = ciphertext.to_vec();
        self.ctr_xor(&nonce_mac, &mut plaintext);
        plaintext
    }

    pub(super) fn eax_tag(&self, nonce: &[u8; 16], ad: &[u8], ciphertext: &[u8]) -> [u8; 16] {
        let nonce_mac = self.omac(0, nonce);
        let header_mac = self.omac(1, ad);
        let message_mac = self.omac(2, ciphertext);
        xor3(&nonce_mac, &header_mac, &message_mac)
    }

    pub(super) fn omac(&self, domain: u8, data: &[u8]) -> [u8; 16] {
        let mut prefixed = Vec::with_capacity(16 + data.len());
        prefixed.extend_from_slice(&[0u8; 15]);
        prefixed.push(domain);
        prefixed.extend_from_slice(data);
        self.cmac(&prefixed)
    }

    pub(super) fn cmac(&self, data: &[u8]) -> [u8; 16] {
        let mut zero = [0u8; 16];
        self.encrypt_block(&mut zero);
        let k1 = dbl_block(&zero);
        let k2 = dbl_block(&k1);

        let block_count = if data.is_empty() {
            1
        } else {
            (data.len() + 15) / 16
        };
        let complete_last = !data.is_empty() && data.len() % 16 == 0;

        let mut x = [0u8; 16];
        for i in 0..block_count - 1 {
            let mut block = [0u8; 16];
            block.copy_from_slice(&data[i * 16..i * 16 + 16]);
            xor_in_place(&mut x, &block);
            self.encrypt_block(&mut x);
        }

        let mut last = [0u8; 16];
        if complete_last {
            last.copy_from_slice(&data[(block_count - 1) * 16..block_count * 16]);
            xor_in_place(&mut last, &k1);
        } else {
            let start = (block_count - 1) * 16;
            let rem = data.len().saturating_sub(start);
            if rem > 0 {
                last[..rem].copy_from_slice(&data[start..]);
            }
            last[rem] = 0x80;
            xor_in_place(&mut last, &k2);
        }

        xor_in_place(&mut x, &last);
        self.encrypt_block(&mut x);
        x
    }

    pub(super) fn ctr_xor(&self, initial_counter: &[u8; 16], data: &mut [u8]) {
        let mut counter = *initial_counter;
        for chunk in data.chunks_mut(16) {
            let mut pad = counter;
            self.encrypt_block(&mut pad);
            for (dst, key_byte) in chunk.iter_mut().zip(pad.iter()) {
                *dst ^= *key_byte;
            }
            increment_be(&mut counter);
        }
    }

    pub(super) fn encrypt_block(&self, block: &mut [u8; 16]) {
        use aes::cipher::{Array, BlockCipherEncrypt};

        match &self.key {
            AesKey::Aes128(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
            }
            AesKey::Aes256(cipher) => {
                cipher.encrypt_block(Array::from_mut_slice(block));
            }
        }
    }
}

pub(super) fn rsa_aes_write_message(
    stream: &mut TcpStream,
    aes: &mut AesEax,
    plaintext: &[u8],
) -> std::io::Result<()> {
    if plaintext.len() > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "RSA-AES message too large",
        ));
    }

    let len = (plaintext.len() as u16).to_be_bytes();
    let (ciphertext, tag) = aes.encrypt_packet(&len, plaintext);
    stream.write_all(&len)?;
    stream.write_all(&ciphertext)?;
    stream.write_all(&tag)?;
    stream.flush()
}

pub(super) fn rsa_aes_read_message(
    stream: &mut TcpStream,
    aes: &mut AesEax,
) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;
    let len = u16::from_be_bytes(len_buf) as usize;
    let mut encrypted = vec![0u8; len + 16];
    stream.read_exact(&mut encrypted)?;

    aes.decrypt_packet(&len_buf, &encrypted[..len], &encrypted[len..])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub(super) fn derive_ra2_aes_keys(
    random_len: usize,
    client_random: &[u8],
    server_random: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    use sha1::Digest;

    if random_len == 16 {
        let mut inbound = sha1::Sha1::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha1::Sha1::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (
            inbound.finalize()[..16].to_vec(),
            outbound.finalize()[..16].to_vec(),
        )
    } else {
        let mut inbound = sha2::Sha256::new();
        inbound.update(client_random);
        inbound.update(server_random);
        let mut outbound = sha2::Sha256::new();
        outbound.update(server_random);
        outbound.update(client_random);
        (inbound.finalize().to_vec(), outbound.finalize().to_vec())
    }
}

pub(super) fn ra2_public_key_hash(
    random_len: usize,
    first_bits: usize,
    first_n: &[u8],
    first_e: &[u8],
    second_bits: usize,
    second_n: &[u8],
    second_e: &[u8],
) -> Vec<u8> {
    use sha1::Digest;

    let mut data =
        Vec::with_capacity(8 + first_n.len() + first_e.len() + second_n.len() + second_e.len());
    data.extend_from_slice(&(first_bits as u32).to_be_bytes());
    data.extend_from_slice(first_n);
    data.extend_from_slice(first_e);
    data.extend_from_slice(&(second_bits as u32).to_be_bytes());
    data.extend_from_slice(second_n);
    data.extend_from_slice(second_e);

    if random_len == 16 {
        sha1::Sha1::digest(&data).to_vec()
    } else {
        sha2::Sha256::digest(&data).to_vec()
    }
}

/// The ARD reply: `{username[64], password[64]}` (NUL-terminated UTF-8, the
/// rest random) encrypted with AES-128-ECB under MD5 of the fixed-width DH
/// shared secret, and the client's public key in the server's key width.
pub(crate) fn ard_response(
    generator: u16,
    prime: &[u8],
    server_public: &[u8],
    username: &str,
    password: &str,
    rng: &mut impl rsa::rand_core::RngCore,
) -> Result<([u8; 2 * ARD_FIELD_BYTES], Vec<u8>), String> {
    use aes::cipher::{Array, BlockCipherEncrypt, KeyInit};
    use md5::Digest;
    use rsa::BigUint;

    for (field, value) in [("username", username), ("password", password)] {
        if value.len() >= ARD_FIELD_BYTES || value.as_bytes().contains(&0) {
            return Err(format!(
                "ARD authentication: the {field} must be under {ARD_FIELD_BYTES} bytes without NUL characters"
            ));
        }
    }
    let key_len = prime.len();
    let p = BigUint::from_bytes_be(prime);
    let one = BigUint::from(1u32);
    let two = BigUint::from(2u32);
    let server_key = BigUint::from_bytes_be(server_public);
    if generator < 2 || p <= BigUint::from(3u32) || server_key <= one || server_key >= &p - &one {
        return Err("ARD authentication: invalid Diffie-Hellman parameters from the server".into());
    }
    let mut secret = vec![0u8; key_len];
    rng.fill_bytes(&mut secret);
    // Private exponent in [1, p - 2].
    let private = BigUint::from_bytes_be(&secret) % (&p - &two) + &one;
    let client_public = BigUint::from(generator).modpow(&private, &p);
    let shared = server_key.modpow(&private, &p);
    let client_public = left_pad(&client_public.to_bytes_be(), key_len, "ARD public key")?;
    let shared = left_pad(&shared.to_bytes_be(), key_len, "ARD shared secret")?;
    let key = md5::Md5::digest(&shared);

    let mut block = [0u8; 2 * ARD_FIELD_BYTES];
    rng.fill_bytes(&mut block);
    for (offset, value) in [(0, username), (ARD_FIELD_BYTES, password)] {
        block[offset..offset + value.len()].copy_from_slice(value.as_bytes());
        block[offset + value.len()] = 0;
    }
    let cipher = aes::Aes128::new_from_slice(&key)
        .map_err(|e| format!("ARD authentication: AES key: {e}"))?;
    for chunk in block.chunks_exact_mut(16) {
        cipher.encrypt_block(Array::from_mut_slice(chunk));
    }
    Ok((block, client_public))
}

pub(super) fn biguint_to_fixed_bytes(value: &rsa::BigUint, len: usize) -> Result<Vec<u8>, String> {
    let bytes = value.to_bytes_be();
    left_pad(&bytes, len, "RSA integer")
}

pub(super) fn left_pad(bytes: &[u8], len: usize, context: &str) -> Result<Vec<u8>, String> {
    if bytes.len() > len {
        return Err(format!(
            "{} is too large: {} bytes, expected at most {}",
            context,
            bytes.len(),
            len
        ));
    }

    let mut out = vec![0u8; len];
    out[len - bytes.len()..].copy_from_slice(bytes);
    Ok(out)
}

pub(super) fn dbl_block(block: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut carry = 0u8;
    for i in (0..16).rev() {
        out[i] = (block[i] << 1) | carry;
        carry = block[i] >> 7;
    }
    if carry != 0 {
        out[15] ^= 0x87;
    }
    out
}

pub(super) fn xor_in_place(dst: &mut [u8; 16], src: &[u8; 16]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        *d ^= *s;
    }
}

pub(super) fn xor3(a: &[u8; 16], b: &[u8; 16], c: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = a[i] ^ b[i] ^ c[i];
    }
    out
}

pub(super) fn increment_be(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut().rev() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
    }
}

pub(super) fn increment_le(counter: &mut [u8; 16]) {
    for byte in counter.iter_mut() {
        let (new, carry) = byte.overflowing_add(1);
        *byte = new;
        if !carry {
            break;
        }
    }
}

/// VNC DES authentication: encrypt the 16-byte challenge with a key derived from the password.
pub(super) fn vnc_des_encrypt(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    use des::Des;
    use des::cipher::{Array, BlockCipherEncrypt, KeyInit};

    // Build key: password truncated/padded to 8 bytes, each byte's bits reversed
    let mut key_bytes = [0u8; 8];
    let pwd_bytes = password.as_bytes();
    for i in 0..8 {
        let b = if i < pwd_bytes.len() { pwd_bytes[i] } else { 0 };
        key_bytes[i] = reverse_bits(b);
    }

    let cipher = Des::new_from_slice(&key_bytes).expect("DES key should be 8 bytes");

    let mut response = [0u8; 16];
    cipher.encrypt_block_b2b(
        Array::from_slice(&challenge[..8]),
        Array::from_mut_slice(&mut response[..8]),
    );
    cipher.encrypt_block_b2b(
        Array::from_slice(&challenge[8..]),
        Array::from_mut_slice(&mut response[8..]),
    );

    response
}

pub(super) fn reverse_bits(b: u8) -> u8 {
    let mut result = 0u8;
    for i in 0..8 {
        result |= ((b >> i) & 1) << (7 - i);
    }
    result
}
