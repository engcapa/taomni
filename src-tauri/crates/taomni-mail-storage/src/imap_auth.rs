/// Format the SASL response for the authorized OAuth identity.
pub fn xoauth2_sasl_response(username: &str, access_token: &str) -> String {
    format!("user={username}\x01auth=Bearer {access_token}\x01\x01")
}
