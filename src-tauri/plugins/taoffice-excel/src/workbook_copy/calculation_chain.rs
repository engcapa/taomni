use crate::workbook_package::{
    CONTENT, CONTENT_TYPES, REL, RELATIONSHIPS, Source, attribute, invalid, part,
};
use quick_xml::{
    NsReader,
    events::{BytesStart, Event},
    name::{Namespace, ResolveResult},
};
use std::collections::{BTreeMap, BTreeSet};
use taomni_plugin_api::RpcError;

const CALC_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain";

fn filter_children(
    xml: &str,
    namespace: &str,
    mut remove: impl FnMut(&BytesStart<'_>) -> Result<bool, RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let mut reader = NsReader::from_str(xml);
    let mut output = Vec::with_capacity(xml.len());
    let mut copied = 0;
    let mut depth = 0usize;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(invalid)?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let opens = matches!(event, Event::Start(_));
                if depth == 1
                    && reader.resolver().resolve_element(tag.name()).0
                        == ResolveResult::Bound(Namespace(namespace))
                    && remove(tag)?
                {
                    if opens {
                        reader.read_to_end(tag.name()).map_err(invalid)?;
                    }
                    output.extend_from_slice(&xml.as_bytes()[copied..start]);
                    copied = reader.buffer_position() as usize;
                } else if opens {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("Unexpected workbook XML end tag"))?
            }
            Event::DocType(_) => {
                return Err(invalid(
                    "Workbook relationships cannot declare a document type",
                ));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    output.extend_from_slice(&xml.as_bytes()[copied..]);
    Ok(output)
}

pub(super) fn remove_chain(
    archive: &mut Source<'_>,
    replacements: &mut BTreeMap<String, Vec<u8>>,
) -> Result<BTreeSet<String>, RpcError> {
    let mut obsolete = BTreeSet::new();
    let relationships = part(archive, RELATIONSHIPS)?;
    let revised = filter_children(&relationships, REL, |tag| {
        if tag.local_name().as_ref() != "Relationship"
            || attribute(tag, "Type")?.as_deref() != Some(CALC_REL)
            || attribute(tag, "TargetMode")?.as_deref() == Some("External")
        {
            return Ok(false);
        }
        let target =
            attribute(tag, "Target")?.ok_or_else(|| invalid("Missing calculation chain target"))?;
        let path = target.strip_prefix("/xl/").unwrap_or(&target);
        if path.contains(['\\', ':', '?', '#', '%'])
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(invalid("Invalid calculation chain target"));
        }
        obsolete.insert(format!("xl/{path}"));
        Ok(true)
    })?;
    if !obsolete.is_empty() {
        let content_types = part(archive, CONTENT_TYPES)?;
        let types = filter_children(&content_types, CONTENT, |tag| {
            Ok(tag.local_name().as_ref() == "Override"
                && attribute(tag, "PartName")?
                    .and_then(|name| name.strip_prefix('/').map(str::to_owned))
                    .is_some_and(|path| obsolete.contains(&path)))
        })?;
        replacements.insert(RELATIONSHIPS.to_owned(), revised);
        replacements.insert(CONTENT_TYPES.to_owned(), types);
    }
    Ok(obsolete)
}
