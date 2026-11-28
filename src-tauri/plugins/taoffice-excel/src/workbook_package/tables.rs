use super::{MAIN, MAX_COLUMNS, MAX_ROWS, REL, Source, attribute, invalid, part, scan};
use calamine::Dimensions;
use std::collections::{HashMap, HashSet};
use taomni_plugin_api::RpcError;

const TABLE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";

pub(crate) fn position(address: &str) -> Option<(u32, u32)> {
    let digits = address.find(|ch: char| ch.is_ascii_digit())?;
    let (column, row) = address.split_at(digits);
    if !(1..=3).contains(&column.len())
        || !column.bytes().all(|byte| byte.is_ascii_uppercase())
        || row.starts_with('0')
        || !row.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let column = column
        .bytes()
        .fold(0, |value, byte| value * 26 + u32::from(byte - b'A') + 1);
    let row = row.parse::<u32>().ok()?;
    (row <= MAX_ROWS && column <= MAX_COLUMNS).then_some((row - 1, column - 1))
}

fn table_part(parent: &str, target: &str) -> Result<String, RpcError> {
    let invalid_target = || invalid("Invalid worksheet table relationship target");
    if target.contains(['\\', ':', '%', '#', '?']) {
        return Err(invalid_target());
    }
    let (path, mut components) = match target.strip_prefix('/') {
        Some(absolute) => (absolute, Vec::new()),
        None => (target, parent.split('/').collect::<Vec<_>>()),
    };
    for component in path.split('/') {
        match component {
            ".." => {
                components.pop().ok_or_else(invalid_target)?;
            }
            "." => (),
            "" => return Err(invalid_target()),
            _ => components.push(component),
        }
    }
    Ok(components.join("/"))
}

fn add_reserved_rows(xml: &str, rows: &mut Vec<Dimensions>) -> Result<(), RpcError> {
    let invalid_range = || invalid("Invalid worksheet table range");
    let mut found = false;
    scan(xml, MAIN, |_, tag, _, _, _, depth| {
        if depth != 0 || tag.local_name().as_ref() != "table" {
            return Ok(());
        }
        let address = attribute(tag, "ref")?.ok_or_else(invalid_range)?;
        let (start, end) = address.split_once(':').unwrap_or((&address, &address));
        let (first_row, first_column) = position(start).ok_or_else(invalid_range)?;
        let (last_row, last_column) = position(end).ok_or_else(invalid_range)?;
        let count = |name, default| -> Result<u32, RpcError> {
            attribute(tag, name)?
                .map(|value| value.parse::<u32>().map_err(invalid))
                .transpose()
                .map(|value| value.unwrap_or(default))
        };
        let header = count("headerRowCount", 1)?;
        let totals = count("totalsRowCount", 0)?;
        if first_row > last_row
            || first_column > last_column
            || header.saturating_add(totals) > last_row - first_row + 1
        {
            return Err(invalid_range());
        }
        if header > 0 {
            rows.push(Dimensions::new(
                (first_row, first_column),
                (first_row + header - 1, last_column),
            ));
        }
        if totals > 0 {
            rows.push(Dimensions::new(
                (last_row + 1 - totals, first_column),
                (last_row, last_column),
            ));
        }
        found = true;
        Ok(())
    })?;
    if !found {
        return Err(invalid("A worksheet table part could not be read"));
    }
    Ok(())
}

pub(super) fn reserved_rows(
    archive: &mut Source<'_>,
    worksheet: &str,
    table_parts: &mut HashMap<String, Option<Vec<Dimensions>>>,
) -> Result<Vec<Dimensions>, RpcError> {
    let (folder, filename) = worksheet
        .rsplit_once('/')
        .ok_or_else(|| invalid("Invalid worksheet path"))?;
    let relationships = format!("{folder}/_rels/{filename}.rels");
    let mut rows = Vec::new();
    if archive.index_for_name(&relationships).is_none() {
        return Ok(rows);
    }
    let xml = part(archive, &relationships)?;
    let mut visited = HashSet::new();
    scan(&xml, REL, |_, tag, _, _, _, depth| {
        if depth == 1
            && tag.local_name().as_ref() == "Relationship"
            && attribute(tag, "Type")?.as_deref() == Some(TABLE_REL)
        {
            if attribute(tag, "TargetMode")?.as_deref() == Some("External") {
                return Err(invalid("External table definitions are read-only"));
            }
            let target = attribute(tag, "Target")?
                .ok_or_else(|| invalid("Missing worksheet table relationship target"))?;
            let path = table_part(folder, &target)?;
            if visited.insert(path.clone()) {
                let reserved = table_parts.entry(path).or_insert_with_key(|path| {
                    let mut reserved = Vec::new();
                    add_reserved_rows(&part(archive, path).ok()?, &mut reserved).ok()?;
                    Some(reserved)
                });
                rows.extend_from_slice(
                    reserved
                        .as_deref()
                        .ok_or_else(|| invalid("The table layout could not be read"))?,
                );
            }
        }
        Ok(())
    })?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_only_the_columns_in_headers_and_totals() {
        let mut rows = Vec::new();
        add_reserved_rows(
            &format!(r#"<table xmlns="{MAIN}" ref="C4:D8" totalsRowCount="1"/>"#),
            &mut rows,
        )
        .unwrap();
        assert_eq!(
            rows,
            [
                Dimensions::new((3, 2), (3, 3)),
                Dimensions::new((7, 2), (7, 3))
            ]
        );
        rows.clear();
        add_reserved_rows(
            &format!(r#"<table xmlns="{MAIN}" ref="C4:D8" headerRowCount="0"/>"#),
            &mut rows,
        )
        .unwrap();
        assert!(rows.is_empty());
        assert!(
            add_reserved_rows(
                &format!(r#"<table xmlns="{MAIN}" ref="C4:D3"/>"#),
                &mut rows,
            )
            .is_err()
        );
    }
}
