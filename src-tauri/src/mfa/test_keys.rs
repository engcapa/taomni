//! Legacy key storage adapter for pure crypto/format tests. Production MFA
//! always uses CoreKeyProvider; access_tests exercise the actual coordinator.
use super::{
    crypto::{self, DataKey},
    key_provider::KeyProvider,
};
use crate::vault::{MFA_DATA_KEY_ENTRY_ID, Vault};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use zeroize::Zeroizing;

pub(super) struct TestKeys<'a>(pub &'a Vault);

impl KeyProvider for TestKeys<'_> {
    fn load(&self) -> Result<Option<DataKey>, String> {
        let Some(encoded) = self.0.get_fixed(MFA_DATA_KEY_ENTRY_ID)? else {
            return Ok(None);
        };
        let bytes = Zeroizing::new(
            STANDARD
                .decode(encoded.trim())
                .map_err(|_| super::ERR_KEY_MISMATCH)?,
        );
        let key: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| super::ERR_KEY_MISMATCH)?;
        Ok(Some(Zeroizing::new(key)))
    }
    fn initialize_empty(&self) -> Result<DataKey, String> {
        if let Some(key) = self.load()? {
            return Ok(key);
        }
        self.create()
    }
    fn repair_after_reset(&self) -> Result<DataKey, String> {
        match self.load() {
            Ok(Some(key)) => Ok(key),
            Ok(None) => self.create(),
            Err(error) if error == super::ERR_KEY_MISMATCH => self.create(),
            Err(error) => Err(error),
        }
    }
}

impl TestKeys<'_> {
    fn create(&self) -> Result<DataKey, String> {
        let mut key = Zeroizing::new([0u8; 32]);
        rand::fill(key.as_mut_slice());
        let encoded = Zeroizing::new(STANDARD.encode(key.as_slice()));
        self.0.put_fixed(
            MFA_DATA_KEY_ENTRY_ID,
            crypto::KEY_KIND,
            crypto::KEY_LABEL,
            &encoded,
        )?;
        Ok(key)
    }
}
