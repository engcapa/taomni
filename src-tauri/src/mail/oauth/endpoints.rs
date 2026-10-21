use crate::mail::connection_model::MailProvider;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest;
use sha2::Sha256;

pub(in crate::mail) fn oauth_authorize_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://accounts.google.com/o/oauth2/v2/auth"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")
        }
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(in crate::mail) fn oauth_token_url(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/token"),
        MailProvider::Outlook => Ok("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(in crate::mail) fn oauth_device_code_url(
    provider: MailProvider,
) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://oauth2.googleapis.com/device/code"),
        MailProvider::Outlook => {
            Ok("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")
        }
        MailProvider::Custom => {
            Err("Device code authorization requires Gmail or Outlook provider".into())
        }
    }
}

pub(in crate::mail) fn oauth_scope(provider: MailProvider) -> Result<&'static str, String> {
    match provider {
        MailProvider::Gmail => Ok("https://mail.google.com/"),
        MailProvider::Outlook => Ok(
            "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        ),
        MailProvider::Custom => Err("OAuth2 mail auth requires Gmail or Outlook provider".into()),
    }
}

pub(in crate::mail) fn random_urlsafe_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(buf.as_mut_slice());
    URL_SAFE_NO_PAD.encode(buf)
}

pub(in crate::mail) fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}
