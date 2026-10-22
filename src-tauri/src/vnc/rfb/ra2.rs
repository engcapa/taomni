use super::model::RfbConnection;
use super::negotiation::RA2_MAX_KEY_BITS;
use super::negotiation::RA2_MIN_KEY_BITS;
use super::negotiation::RA2_SUBTYPE_PASS;
use super::negotiation::RA2_SUBTYPE_USER_PASS;
use super::negotiation::SEC_TYPE_RA2_128;
use super::negotiation::SEC_TYPE_RA2_256;
use super::negotiation::SEC_TYPE_RA2NE_128;
use super::negotiation::SEC_TYPE_RA2NE_256;
use crate::vnc::rfb::security::AesEax;
use crate::vnc::rfb::security::RsaAesIo;
use crate::vnc::rfb::security::biguint_to_fixed_bytes;
use crate::vnc::rfb::security::derive_ra2_aes_keys;
use crate::vnc::rfb::security::left_pad;
use crate::vnc::rfb::security::ra2_public_key_hash;
use crate::vnc::rfb::security::rsa_aes_read_message;
use crate::vnc::rfb::security::rsa_aes_write_message;
use std::io::Read;
use std::io::Write;

impl RfbConnection {
    /// RealVNC RSA-AES authentication (RA2/RA2ne, 128- and 256-bit variants).
    pub(super) fn vnc_auth_ra2(
        &mut self,
        sec_type: u8,
        username: &str,
        password: &str,
    ) -> Result<(), String> {
        use rsa::pkcs1v15::Pkcs1v15Encrypt;
        use rsa::rand_core::RngCore;
        use rsa::traits::PublicKeyParts;
        use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};

        let (random_len, all_encrypted) = match sec_type {
            SEC_TYPE_RA2_128 => (16usize, true),
            SEC_TYPE_RA2NE_128 => (16usize, false),
            SEC_TYPE_RA2_256 => (32usize, true),
            SEC_TYPE_RA2NE_256 => (32usize, false),
            _ => return Err(format!("RA2: unsupported security type {}", sec_type)),
        };

        // 1. Read server public key: u32 key bits, modulus, exponent.
        let mut len_buf = [0u8; 4];
        self.read_exact(&mut len_buf)
            .map_err(|e| format!("RA2: read key length: {}", e))?;
        let key_bits = u32::from_be_bytes(len_buf) as usize;

        if !(RA2_MIN_KEY_BITS..=RA2_MAX_KEY_BITS).contains(&key_bits) {
            return Err(format!("RA2: unreasonable key length: {} bits", key_bits));
        }
        let key_bytes_len = (key_bits + 7) / 8;

        let mut server_n = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_n)
            .map_err(|e| format!("RA2: read modulus: {}", e))?;
        let mut server_e = vec![0u8; key_bytes_len];
        self.read_exact(&mut server_e)
            .map_err(|e| format!("RA2: read exponent: {}", e))?;

        let modulus = BigUint::from_bytes_be(&server_n);
        let exponent = BigUint::from_bytes_be(&server_e);
        let server_pubkey = RsaPublicKey::new(modulus, exponent)
            .map_err(|e| format!("RA2: construct server pubkey: {}", e))?;

        // 2. Generate a client key pair matching the server key size and send
        //    the public key in RealVNC's fixed-width format.
        let mut rng = rsa::rand_core::OsRng;
        let client_privkey = RsaPrivateKey::new(&mut rng, key_bits)
            .map_err(|e| format!("RA2: gen client key: {}", e))?;
        let client_pubkey = RsaPublicKey::from(&client_privkey);
        let client_n = biguint_to_fixed_bytes(client_pubkey.n(), key_bytes_len)?;
        let client_e = biguint_to_fixed_bytes(client_pubkey.e(), key_bytes_len)?;

        self.write_all(&(key_bits as u32).to_be_bytes())
            .map_err(|e| format!("RA2: write client key length: {}", e))?;
        self.write_all(&client_n)
            .map_err(|e| format!("RA2: write client modulus: {}", e))?;
        self.write_all(&client_e)
            .map_err(|e| format!("RA2: write client exponent: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client key: {}", e))?;

        // 3. Send the client random encrypted with the server's public key.
        let mut client_random = vec![0u8; random_len];
        rng.fill_bytes(&mut client_random);
        let encrypted_client_random = server_pubkey
            .encrypt(&mut rng, Pkcs1v15Encrypt, &client_random)
            .map_err(|e| format!("RA2: RSA encrypt: {}", e))?;
        let encrypted_client_random = left_pad(
            &encrypted_client_random,
            key_bytes_len,
            "RA2: encrypted client random",
        )?;

        self.write_all(&(key_bytes_len as u16).to_be_bytes())
            .map_err(|e| format!("RA2: write encrypted client random len: {}", e))?;
        self.write_all(&encrypted_client_random)
            .map_err(|e| format!("RA2: write encrypted client random: {}", e))?;
        self.flush()
            .map_err(|e| format!("RA2: flush client random: {}", e))?;

        // 4. Read and decrypt the server random with the client private key.
        let mut enc_len_buf = [0u8; 2];
        self.read_exact(&mut enc_len_buf)
            .map_err(|e| format!("RA2: read encrypted server random len: {}", e))?;
        let encrypted_server_random_len = u16::from_be_bytes(enc_len_buf) as usize;
        if encrypted_server_random_len != key_bytes_len {
            return Err(format!(
                "RA2: encrypted server random length mismatch: got {}, expected {}",
                encrypted_server_random_len, key_bytes_len
            ));
        }
        let mut encrypted_server_random = vec![0u8; encrypted_server_random_len];
        self.read_exact(&mut encrypted_server_random)
            .map_err(|e| format!("RA2: read encrypted server random: {}", e))?;
        let server_random = client_privkey
            .decrypt(Pkcs1v15Encrypt, &encrypted_server_random)
            .map_err(|e| format!("RA2: RSA decrypt server random: {}", e))?;
        if server_random.len() != random_len {
            return Err(format!(
                "RA2: decrypted server random length mismatch: got {}, expected {}",
                server_random.len(),
                random_len
            ));
        }

        // 5. All remaining RA2 authentication messages are AES-EAX framed.
        let (in_key, out_key) = derive_ra2_aes_keys(random_len, &client_random, &server_random);
        let mut aes_in = AesEax::new(&in_key)?;
        let mut aes_out = AesEax::new(&out_key)?;

        let client_hash = ra2_public_key_hash(
            random_len, key_bits, &client_n, &client_e, key_bits, &server_n, &server_e,
        );
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &client_hash)
            .map_err(|e| format!("RA2: write client hash: {}", e))?;

        let server_hash = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read server hash: {}", e))?;
        let expected_server_hash = ra2_public_key_hash(
            random_len, key_bits, &server_n, &server_e, key_bits, &client_n, &client_e,
        );
        if server_hash != expected_server_hash {
            return Err("RA2: server hash does not match".to_string());
        }

        let subtype_msg = rsa_aes_read_message(&mut self.stream, &mut aes_in)
            .map_err(|e| format!("RA2: read auth subtype: {}", e))?;
        if subtype_msg.len() != 1 {
            return Err(format!(
                "RA2: invalid auth subtype length {}",
                subtype_msg.len()
            ));
        }
        let subtype = subtype_msg[0];
        if subtype != RA2_SUBTYPE_USER_PASS && subtype != RA2_SUBTYPE_PASS {
            return Err(format!("RA2: unsupported auth subtype {}", subtype));
        }

        let username_bytes = username.as_bytes();
        if subtype == RA2_SUBTYPE_USER_PASS && username_bytes.is_empty() {
            return Err(
                "RA2: server requested username/password authentication, but no VNC username was provided"
                    .to_string(),
            );
        }
        if username_bytes.len() > u8::MAX as usize {
            return Err("RA2: username is too long; maximum is 255 bytes".to_string());
        }

        let password_bytes = password.as_bytes();
        if password_bytes.len() > u8::MAX as usize {
            return Err("RA2: password is too long; maximum is 255 bytes".to_string());
        }

        let credential_username_len = if subtype == RA2_SUBTYPE_USER_PASS {
            username_bytes.len()
        } else {
            0
        };
        let mut credentials =
            Vec::with_capacity(password_bytes.len() + credential_username_len + 2);
        if subtype == RA2_SUBTYPE_USER_PASS {
            credentials.push(username_bytes.len() as u8);
            credentials.extend_from_slice(username_bytes);
        } else {
            credentials.push(0);
        }
        credentials.push(password_bytes.len() as u8);
        credentials.extend_from_slice(password_bytes);
        rsa_aes_write_message(&mut self.stream, &mut aes_out, &credentials)
            .map_err(|e| format!("RA2: write credentials: {}", e))?;

        if all_encrypted {
            self.secure_io = Some(RsaAesIo::new(aes_in, aes_out));
        }

        Ok(())
    }
}
