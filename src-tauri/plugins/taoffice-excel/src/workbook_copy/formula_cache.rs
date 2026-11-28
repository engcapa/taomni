use super::calculation::CachedValue;
use crate::workbook_package::{MAIN, attribute, invalid};
use quick_xml::{
    NsReader, Writer,
    events::{BytesStart, Event},
    name::{Namespace, ResolveResult},
};
use std::collections::BTreeMap;
use std::ops::Range;
use taomni_plugin_api::RpcError;

struct Target {
    tag: BytesStart<'static>,
    start: Range<usize>,
    value: CachedValue,
    formula: bool,
    cached: Option<Range<usize>>,
    cache_start: usize,
    insert_at: usize,
}

impl Target {
    fn patch(self, xml: &str, edits: &mut Vec<(Range<usize>, String)>) -> Result<(), RpcError> {
        if !self.formula {
            return Err(invalid("The calculated cell has no worksheet formula"));
        }
        let kind = attribute(&self.tag, "t")?;
        if kind.as_deref().unwrap_or("n") != self.value.kind {
            let mut tag = self.tag.clone();
            tag.clear_attributes();
            for attr in self.tag.attributes() {
                let attr = attr.map_err(invalid)?;
                if attr.key.as_ref() != "t" {
                    tag.push_attribute(attr);
                }
            }
            tag.push_attribute(("t", self.value.kind));
            let mut writer = Writer::new(Vec::new());
            writer.write_event(Event::Start(tag)).map_err(invalid)?;
            edits.push((
                self.start,
                String::from_utf8(writer.into_inner()).map_err(invalid)?,
            ));
        }
        let name = self.tag.name();
        let prefix = name
            .as_ref()
            .rsplit_once(':')
            .map_or("", |(prefix, _)| prefix);
        let value_tag = if prefix.is_empty() {
            "v".into()
        } else {
            format!("{prefix}:v")
        };
        let text = if self.value.kind == "str" {
            super::sheet::escape_excel_text(&self.value.value)
        } else {
            self.value.value
        };
        let encoded = quick_xml::escape::escape(&text);
        let new = format!("<{value_tag}>{encoded}</{value_tag}>");
        let range = self.cached.unwrap_or(self.insert_at..self.insert_at);
        if xml[range.clone()] != new {
            edits.push((range, new));
        }
        Ok(())
    }
}

/// Keep formula text, shared-formula attributes, row formatting, extensions
/// and untouched XML byte-for-byte. Replace only a cell's result type and v.
pub(super) fn rewrite(
    xml: &str,
    mut values: BTreeMap<String, CachedValue>,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Option<Vec<u8>>, RpcError> {
    let mut reader = NsReader::from_str(xml);
    let mut path = Vec::new();
    let mut target: Option<Target> = None;
    let mut edits = Vec::new();
    let mut events = 0usize;
    loop {
        events += 1;
        if events % 256 == 0 {
            check_current()?;
        }
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(invalid)?;
        let end = reader.buffer_position() as usize;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = if reader.resolver().resolve_element(tag.name()).0
                    == ResolveResult::Bound(Namespace(MAIN))
                {
                    tag.local_name().as_ref().to_owned()
                } else {
                    String::new()
                };
                let empty = matches!(event, Event::Empty(_));
                if name == "c" && path == ["worksheet", "sheetData", "row"] {
                    if let Some(value) =
                        attribute(tag, "r")?.and_then(|address| values.remove(&address))
                    {
                        target = Some(Target {
                            tag: tag.to_owned(),
                            start: start..end,
                            value,
                            formula: false,
                            cached: None,
                            cache_start: 0,
                            insert_at: end,
                        });
                    }
                } else if let Some(cell) = target.as_mut()
                    && path.len() == 4
                {
                    if name == "f" {
                        cell.formula = true;
                        cell.insert_at = end;
                    }
                    if name == "v" {
                        cell.cache_start = start;
                        if empty {
                            cell.cached = Some(start..end);
                        }
                    }
                }
                if !empty {
                    path.push(name);
                }
            }
            Event::End(_) => {
                let name = path.pop();
                if let Some(cell) = &mut target
                    && path.len() == 4
                {
                    match name.as_deref() {
                        Some("f") => cell.insert_at = end,
                        Some("v") => cell.cached = Some(cell.cache_start..end),
                        _ => {}
                    }
                }
                if path.len() == 3
                    && name.as_deref() == Some("c")
                    && let Some(cell) = target.take()
                {
                    cell.patch(xml, &mut edits)?;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !values.is_empty() {
        return Err(invalid("Calculated formulas do not match the worksheet"));
    }
    if edits.is_empty() {
        return Ok(None);
    }
    let mut output = Vec::with_capacity(xml.len());
    let mut offset = 0;
    for (range, value) in edits {
        output.extend_from_slice(&xml.as_bytes()[offset..range.start]);
        output.extend_from_slice(value.as_bytes());
        offset = range.end;
    }
    output.extend_from_slice(&xml.as_bytes()[offset..]);
    Ok(Some(output))
}
