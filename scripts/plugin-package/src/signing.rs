//! Production Minisign identity; there is no CLI public-key override.

use std::{fs::File, io::Read, path::Path};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use minisign::{PublicKey, PublicKeyBox, SecretKey, SecretKeyBox};
use minisign_verify::{PublicKey as VerifyingKey, Signature};

pub struct ReleaseSigner {
    secret: SecretKey,
    public: PublicKey,
    verifier: VerifyingKey,
}

impl ReleaseSigner {
    pub fn from_environment() -> Result<Self> {
        let encoded = std::env::var("TAURI_SIGNING_PRIVATE_KEY")
            .context("TAURI_SIGNING_PRIVATE_KEY is required")?;
        let password = std::env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default();
        Self::decode(&encoded, password, &embedded_public_key()?)
    }

    fn decode(encoded: &str, password: String, public: &str) -> Result<Self> {
        let text = if encoded.trim_start().starts_with("untrusted comment: ") {
            encoded.trim().to_owned()
        } else {
            let bytes = STANDARD
                .decode(encoded.trim())
                .map_err(|_| anyhow::anyhow!("invalid signing key encoding"))?;
            String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("invalid signing key encoding"))?
        };
        let boxed =
            SecretKeyBox::from_string(&text).map_err(|_| anyhow::anyhow!("invalid signing key"))?;
        let secret = boxed
            .clone()
            .into_unencrypted_secret_key()
            .or_else(|_| boxed.into_secret_key(Some(password)))
            .map_err(|_| anyhow::anyhow!("cannot decrypt signing key"))?;
        let public_text = String::from_utf8(STANDARD.decode(public.trim())?)?;
        let public = PublicKeyBox::from_string(&public_text)?.into_public_key()?;
        let derived = PublicKey::from_secret_key(&secret)?;
        ensure!(
            derived.to_bytes() == public.to_bytes(),
            "signing key does not match the embedded release identity"
        );
        let verifier = VerifyingKey::decode(&public_text)?;
        Ok(Self {
            secret,
            public,
            verifier,
        })
    }

    pub fn sign(&self, path: &Path, comment: &str) -> Result<String> {
        ensure!(
            !comment.contains(['\n', '\r']),
            "trusted comment must have one line"
        );
        let signature = minisign::sign(
            Some(&self.public),
            &self.secret,
            File::open(path)?,
            Some(comment),
            Some("Taomni official module package"),
        )?
        .to_string();
        self.verify(path, &signature, comment)?;
        Ok(signature)
    }

    pub(crate) fn verify(&self, path: &Path, signature: &str, comment: &str) -> Result<()> {
        verify_file(&self.verifier, path, signature, comment)
    }

    pub(crate) fn verify_bytes(&self, bytes: &[u8], signature: &str, comment: &str) -> Result<()> {
        verify_reader(&self.verifier, bytes, signature, comment)
    }

    #[cfg(test)]
    pub(crate) fn test_key() -> Self {
        let keys = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let public_text = keys.pk.to_box().unwrap().to_string();
        Self {
            secret: keys.sk,
            public: keys.pk,
            verifier: VerifyingKey::decode(&public_text).unwrap(),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_verifier(&self) -> &VerifyingKey {
        &self.verifier
    }
}

fn embedded_public_key() -> Result<String> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json"))?;
    Ok(config["plugins"]["updater"]["pubkey"]
        .as_str()
        .context("embedded release key is missing")?
        .to_owned())
}

pub(crate) fn public_verifier() -> Result<VerifyingKey> {
    let encoded = embedded_public_key()?;
    Ok(VerifyingKey::decode(&String::from_utf8(
        STANDARD.decode(encoded.trim())?,
    )?)?)
}

pub(crate) fn verify_file(
    verifier: &VerifyingKey,
    path: &Path,
    signature: &str,
    comment: &str,
) -> Result<()> {
    verify_reader(verifier, File::open(path)?, signature, comment)
}

pub(crate) fn verify_reader(
    verifier: &VerifyingKey,
    mut source: impl Read,
    signature: &str,
    comment: &str,
) -> Result<()> {
    let signature = Signature::decode(signature)?;
    ensure!(
        signature.trusted_comment() == comment,
        "detached signature identifies different release metadata"
    );
    let mut stream = verifier.verify_stream(&signature)?;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let size = source.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        stream.update(&buffer[..size]);
    }
    if stream.finalize().is_err() {
        bail!("module signature failed independent verification");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_binds_payload_and_every_comment_field() {
        let signer = ReleaseSigner::test_key();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package");
        std::fs::write(&path, b"official bytes").unwrap();
        let comment = "id=taomni-plugin-hello-plugin version=0.1.0 platform=linux-x86_64 coreApiVersion=1 sha256=abc";
        let signature = signer.sign(&path, comment).unwrap();
        for field in [
            "hello-plugin",
            "0.1.0",
            "linux-x86_64",
            "coreApiVersion=1",
            "sha256=abc",
        ] {
            assert!(
                signer
                    .verify(
                        &path,
                        &signature.replace(field, "changed"),
                        &comment.replace(field, "changed")
                    )
                    .is_err()
            );
        }
        std::fs::write(&path, b"changed bytes").unwrap();
        assert!(signer.verify(&path, &signature, comment).is_err());
    }

    #[test]
    fn tauri_encoded_secret_requires_matching_pinned_key() {
        let keys = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let secret = STANDARD.encode(keys.sk.to_box(None).unwrap().to_string());
        let public = STANDARD.encode(keys.pk.to_box().unwrap().to_string());
        assert!(ReleaseSigner::decode(&secret, String::new(), &public).is_ok());
        let other = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let wrong = STANDARD.encode(other.pk.to_box().unwrap().to_string());
        assert!(ReleaseSigner::decode(&secret, String::new(), &wrong).is_err());
        let error =
            ReleaseSigner::decode("private-value-must-not-be-logged", String::new(), &public)
                .err()
                .unwrap()
                .to_string();
        assert!(error.contains("invalid signing key"));
        assert!(!error.contains("private-value-must-not-be-logged"));
    }

    #[test]
    fn encrypted_tauri_secret_accepts_only_the_correct_environment_password() {
        let keys =
            minisign::KeyPair::generate_encrypted_keypair(Some("unit password".into())).unwrap();
        let secret = STANDARD.encode(keys.sk.to_box(None).unwrap().to_string());
        let public = STANDARD.encode(keys.pk.to_box().unwrap().to_string());
        let signer = ReleaseSigner::decode(&secret, "unit password".into(), &public).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("artifact");
        std::fs::write(&file, b"encrypted key compatibility").unwrap();
        assert!(signer.sign(&file, "id=taomni-plugin-test").is_ok());
        let error = ReleaseSigner::decode(&secret, "wrong unit password".into(), &public)
            .err()
            .unwrap()
            .to_string();
        assert_eq!(error, "cannot decrypt signing key");
        assert!(!error.contains(&secret));
    }
}
