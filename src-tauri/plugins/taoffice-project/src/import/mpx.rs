use mpxj::{
    CodePage,
    mpx::{locale_data::LocaleData, locale_utility::MpxLocale},
};

// MPX stores its code page in the creation record, but the language of its
// field names and predecessor abbreviations is implicit. Use the first task
// or resource field definition to select the matching MPXJ language table.
pub(super) fn locale(bytes: &[u8]) -> MpxLocale {
    let Some(&separator) = bytes.get(3).filter(|byte| byte.is_ascii()) else {
        return MpxLocale::En;
    };
    let mut records = bytes.split(|byte| matches!(byte, b'\r' | b'\n'));
    let code_page = records
        .next()
        .and_then(|line| line.split(|byte| *byte == separator).nth(3))
        .and_then(|name| std::str::from_utf8(name).ok())
        .map(|name| CodePage::get_instance(name.trim_matches('"')))
        .unwrap_or(CodePage::Ansi);
    let Some(encoding) = code_page
        .get_charset()
        .or_else(|| CodePage::Ansi.get_charset())
    else {
        return MpxLocale::En;
    };

    for record in records {
        if record.get(2) != Some(&separator) || record.len() > 64 * 1024 {
            continue;
        }
        let key = match &record[..2] {
            b"60" => LocaleData::TASK_NAMES,
            b"40" => LocaleData::RESOURCE_NAMES,
            _ => continue,
        };
        let (text, _) = encoding.decode_without_bom_handling(&record[3..]);
        let fields: std::collections::HashSet<_> = text
            .split(char::from(separator))
            .take(256)
            .map(|field| field.trim_matches('"'))
            .collect();
        let mut best = MpxLocale::En;
        let mut best_score = 0;
        for language in MpxLocale::ALL {
            let names = LocaleData::get_string_array(language, key).unwrap_or_default();
            let score = names
                .iter()
                .flatten()
                .filter(|name| fields.contains(**name))
                .count();
            if score > best_score {
                best = language;
                best_score = score;
            }
        }
        if best_score != 0 {
            return best;
        }
    }
    MpxLocale::En
}
