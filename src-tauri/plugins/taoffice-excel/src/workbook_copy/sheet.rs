use super::{MAIN, attribute, invalid};
use quick_xml::{
    NsReader, Writer,
    events::{BytesEnd, BytesStart, BytesText, Event},
    name::{Namespace, ResolveResult},
};
use std::collections::BTreeMap;
use taomni_plugin_api::RpcError;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Element {
    Worksheet,
    SheetData,
    Row,
    Cell,
    Value,
    InlineString,
    Text,
    Other,
}

impl Element {
    fn from(parent: Option<Self>, tag: &str) -> Self {
        match (parent, tag) {
            (None, "worksheet") => Self::Worksheet,
            (Some(Self::Worksheet), "sheetData") => Self::SheetData,
            (Some(Self::SheetData), "row") => Self::Row,
            (Some(Self::Row), "c") => Self::Cell,
            (Some(Self::Cell), "v") => Self::Value,
            (Some(Self::Cell), "is") => Self::InlineString,
            (Some(Self::InlineString), "t") => Self::Text,
            _ => Self::Other,
        }
    }
}

struct SelectedCell {
    start: usize,
    tag: BytesStart<'static>,
    value: String,
    has_value: bool,
}

fn ordinary_cell_error() -> RpcError {
    invalid("Only existing plain text and numeric cells can be edited")
}

fn replace(cell: SelectedCell) -> Result<Vec<u8>, RpcError> {
    if !cell.has_value {
        return Err(ordinary_cell_error());
    }
    let text_cell = match attribute(&cell.tag, "t")?.as_deref() {
        None | Some("n") => false,
        Some("s" | "inlineStr") => true,
        _ => return Err(ordinary_cell_error()),
    };
    let mut updated = cell.tag.clone();
    updated.clear_attributes();
    for attr in cell.tag.attributes() {
        let attr = attr.map_err(invalid)?;
        match attr.key.as_ref() {
            "r" | "s" => updated.push_attribute(attr),
            "t" => {}
            _ => return Err(ordinary_cell_error()),
        }
    }
    let tag_name = cell.tag.name();
    let name = tag_name.as_ref();
    let prefix = name
        .rsplit_once(':')
        .map(|(prefix, _)| format!("{prefix}:"))
        .unwrap_or_default();
    let mut writer = Writer::new(Vec::new());
    if text_cell {
        updated.push_attribute(("t", "inlineStr"));
        let inline = format!("{prefix}is");
        let text = format!("{prefix}t");
        // Literal _xNNNN_ is interpreted by Excel as an escape sequence.
        // Preserve the user's bytes by escaping the leading underscore.
        let value = escape_excel_text(&cell.value);
        writer.write_event(Event::Start(updated)).map_err(invalid)?;
        writer
            .write_event(Event::Start(BytesStart::new(inline.as_str())))
            .map_err(invalid)?;
        let mut text_tag = BytesStart::new(text.as_str());
        text_tag.push_attribute(("xml:space", "preserve"));
        writer
            .write_event(Event::Start(text_tag))
            .map_err(invalid)?;
        writer
            .write_event(Event::Text(BytesText::new(&value)))
            .map_err(invalid)?;
        writer
            .write_event(Event::End(BytesEnd::new(text)))
            .map_err(invalid)?;
        writer
            .write_event(Event::End(BytesEnd::new(inline)))
            .map_err(invalid)?;
    } else {
        let numeric = cell.value.trim();
        if !numeric.parse::<f64>().is_ok_and(f64::is_finite) {
            return Err(invalid("Enter a finite number for this cell"));
        }
        let value_tag = format!("{prefix}v");
        writer.write_event(Event::Start(updated)).map_err(invalid)?;
        writer
            .write_event(Event::Start(BytesStart::new(value_tag.as_str())))
            .map_err(invalid)?;
        writer
            .write_event(Event::Text(BytesText::new(numeric)))
            .map_err(invalid)?;
        writer
            .write_event(Event::End(BytesEnd::new(value_tag)))
            .map_err(invalid)?;
    }
    writer
        .write_event(Event::End(BytesEnd::new(name)))
        .map_err(invalid)?;
    Ok(writer.into_inner())
}

fn escape_excel_text(value: &str) -> String {
    let mut encoded = String::new();
    for (index, char) in value.char_indices() {
        if char == '_'
            && let Some(escape) = value.as_bytes().get(index + 1..index + 7)
            && escape[0] == b'x'
            && escape[5] == b'_'
            && escape[1..5].iter().all(u8::is_ascii_hexdigit)
        {
            encoded.push_str("_x005F_");
        } else {
            encoded.push(char);
        }
    }
    encoded
}

pub(super) fn rewrite(
    xml: &str,
    mut edits: BTreeMap<String, String>,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let mut reader = NsReader::from_str(xml);
    let mut parents = Vec::new();
    let mut selected = None::<SelectedCell>;
    let mut output = Vec::with_capacity(xml.len());
    let mut copied = 0;
    let mut count = 0usize;
    loop {
        count += 1;
        if count % 256 == 0 {
            check_current()?;
        }
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(invalid)?;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                let is_sheet_element = reader.resolver().resolve_element(tag.name()).0
                    == ResolveResult::Bound(Namespace(MAIN));
                let local = tag.local_name();
                let local = local.as_ref();
                let parent = parents.last().copied();
                if is_sheet_element
                    && parent == Some(Element::Worksheet)
                    && matches!(
                        local,
                        "sheetProtection" | "protectedRanges" | "mergeCells" | "dataValidations"
                    )
                {
                    return Err(invalid(
                        "Workbooks with protected ranges, merged cells or validation on this sheet are read-only here",
                    ));
                }
                if is_sheet_element
                    && local == "f"
                    && matches!(attribute(tag, "t")?.as_deref(), Some("array" | "dataTable"))
                {
                    return Err(invalid(
                        "This worksheet contains an array or data-table formula",
                    ));
                }
                let element = if is_sheet_element {
                    Element::from(parent, local)
                } else {
                    Element::Other
                };
                if let Some(cell) = selected.as_mut() {
                    match element {
                        Element::Value | Element::Text => cell.has_value = true,
                        Element::InlineString => (),
                        _ => return Err(ordinary_cell_error()),
                    }
                } else if element == Element::Cell
                    && let Some(address) = attribute(tag, "r")?
                    && let Some(value) = edits.remove(&address)
                {
                    if matches!(event, Event::Empty(_)) {
                        return Err(ordinary_cell_error());
                    }
                    selected = Some(SelectedCell {
                        start,
                        tag: tag.to_owned(),
                        value,
                        has_value: false,
                    });
                }
                if matches!(event, Event::Start(_)) {
                    parents.push(element);
                    if parents.len() > 64 {
                        return Err(invalid("Workbook XML is nested too deeply"));
                    }
                }
            }
            Event::End(_) => {
                if parents.pop() == Some(Element::Cell)
                    && let Some(cell) = selected.take()
                {
                    output.extend_from_slice(&xml.as_bytes()[copied..cell.start]);
                    output.extend(replace(cell)?);
                    copied = reader.buffer_position() as usize;
                }
            }
            Event::DocType(_) => {
                return Err(invalid(
                    "XML document types are unsupported in editable workbooks",
                ));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !edits.is_empty() {
        return Err(ordinary_cell_error());
    }
    output.extend_from_slice(&xml.as_bytes()[copied..]);
    Ok(output)
}
