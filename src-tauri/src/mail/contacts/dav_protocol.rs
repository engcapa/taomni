use reqwest::Url;

pub(super) fn card_file_name(uid: &str) -> String {
    let safe: String = uid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.vcf")
}

pub(super) fn multiget_body(hrefs: &[String]) -> String {
    let items: String = hrefs
        .iter()
        .map(|href| {
            let escaped = href.replace('&', "&amp;").replace('<', "&lt;");
            format!("<d:href>{escaped}</d:href>")
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>{items}</card:addressbook-multiget>"#
    )
}

pub(super) fn collection_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|e| format!("invalid CardDAV URL: {e}"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("the CardDAV URL must start with https://".into());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}
