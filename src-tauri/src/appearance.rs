use std::collections::BTreeMap;

use font_kit::source::SystemSource;

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    let families = tokio::task::spawn_blocking(|| {
        SystemSource::new()
            .all_families()
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())??;

    let mut unique = BTreeMap::new();
    for family in families {
        let family = family.trim().to_string();
        if family.is_empty() {
            continue;
        }
        unique.entry(family.to_lowercase()).or_insert(family);
    }

    Ok(unique.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::list_system_fonts;

    #[tokio::test]
    async fn lists_installed_font_families() {
        let fonts = list_system_fonts()
            .await
            .expect("system font enumeration should succeed");

        assert!(!fonts.is_empty(), "expected at least one installed font family");
        assert!(
            fonts.iter().all(|font| !font.trim().is_empty()),
            "font family names should not be blank",
        );

        let mut sorted = fonts.clone();
        sorted.sort_by_key(|font| font.to_lowercase());
        sorted.dedup_by_key(|font| font.to_lowercase());
        assert_eq!(fonts, sorted, "font family names should be sorted and deduplicated");
    }
}
