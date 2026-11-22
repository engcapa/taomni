pub use taomni_mail_api::message::MailListUnsubscribe;

/// Parse the `<uri>, <uri>` list; `None` when no usable URI is present.
pub fn parse_list_unsubscribe(
    value: Option<&str>,
    post: Option<&str>,
) -> Option<MailListUnsubscribe> {
    let raw = value?;
    let mut uris = Vec::new();
    let mut rest = raw;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open + 1..].find('>') else {
            break;
        };
        let uri: String = rest[open + 1..open + 1 + close]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let lower = uri.to_ascii_lowercase();
        if lower.starts_with("https:") || lower.starts_with("http:") || lower.starts_with("mailto:")
        {
            uris.push(uri);
        }
        rest = &rest[open + 1 + close + 1..];
    }
    if uris.is_empty() {
        return None;
    }
    let one_click = post.is_some_and(|post| {
        post.split(|c: char| c.is_whitespace() || c == ';')
            .any(|token| token.eq_ignore_ascii_case("List-Unsubscribe=One-Click"))
    }) && uris
        .iter()
        .any(|uri| uri.to_ascii_lowercase().starts_with("https:"));
    Some(MailListUnsubscribe { uris, one_click })
}
