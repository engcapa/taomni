use std::collections::BTreeMap;
#[derive(Debug, Clone)]
pub(super) enum ShellCommand {
    Help,
    List,
    Status,
    Version,
    Describe {
        table: String,
    },
    Create {
        table: String,
        families: Vec<FamilySpec>,
    },
    Drop {
        table: String,
    },
    Get {
        table: String,
        row: String,
        column: Option<String>,
    },
    Scan {
        table: String,
        limit: usize,
        start_row: Option<String>,
        stop_row: Option<String>,
        columns: Vec<String>,
    },
    Put {
        table: String,
        row: String,
        column: String,
        value: String,
    },
    Delete {
        table: String,
        row: String,
        column: String,
    },
    DeleteAll {
        table: String,
        row: String,
    },
    Count {
        table: String,
    },
    Exists {
        table: String,
    },
    Enable {
        table: String,
    },
    Disable {
        table: String,
    },
    Alter {
        table: String,
        families: Vec<FamilySpec>,
    },
}

#[derive(Debug, Clone)]
pub(super) struct FamilySpec {
    pub(super) name: String,
    pub(super) attributes: BTreeMap<String, String>,
}

pub(super) fn parse_shell_command(input: &str) -> Result<ShellCommand, String> {
    let trimmed = input.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("Enter an HBase shell command".into());
    }
    let (name, rest) = split_command_name(trimmed);
    let args = split_top_level(rest.trim(), ',')
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>();
    match name.to_ascii_lowercase().as_str() {
        "help" | "?" => Ok(ShellCommand::Help),
        "list" => Ok(ShellCommand::List),
        "status" => Ok(ShellCommand::Status),
        "version" => Ok(ShellCommand::Version),
        "describe" | "desc" => Ok(ShellCommand::Describe {
            table: required_arg(&args, 0, "describe table")?,
        }),
        "create" => {
            let table = required_arg(&args, 0, "create table")?;
            let families = args
                .iter()
                .skip(1)
                .map(|arg| parse_family_spec(arg))
                .collect::<Result<Vec<_>, _>>()?;
            if families.is_empty() {
                return Err("create requires at least one column family".into());
            }
            Ok(ShellCommand::Create { table, families })
        }
        "drop" => Ok(ShellCommand::Drop {
            table: required_arg(&args, 0, "drop table")?,
        }),
        "get" => {
            let table = required_arg(&args, 0, "get table")?;
            let row = required_arg(&args, 1, "get row")?;
            // The third arg is either an option map (`{COLUMN=>'cf:q'}`) or a
            // bare column literal (`'cf:q'`). Only parse it as a map when it
            // actually looks like one, so a bare column doesn't error out.
            let third = args.get(2).map(|s| s.trim());
            let column = match third {
                Some(s) if s.starts_with('{') => parse_options(s)?.get("COLUMN").cloned(),
                Some(s) if !s.is_empty() => Some(strip_quotes(s)),
                _ => None,
            };
            Ok(ShellCommand::Get { table, row, column })
        }
        "scan" => {
            let table = required_arg(&args, 0, "scan table")?;
            let opts = args
                .get(1)
                .map(|s| parse_options(s))
                .transpose()?
                .unwrap_or_default();
            let limit = opts
                .get("LIMIT")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(100)
                .clamp(1, 10_000);
            let columns = opts
                .get("COLUMNS")
                .or_else(|| opts.get("COLUMN"))
                .map(|v| parse_columns_value(v))
                .unwrap_or_default();
            Ok(ShellCommand::Scan {
                table,
                limit,
                start_row: opts.get("STARTROW").cloned(),
                stop_row: opts.get("STOPROW").or_else(|| opts.get("ENDROW")).cloned(),
                columns,
            })
        }
        "put" => Ok(ShellCommand::Put {
            table: required_arg(&args, 0, "put table")?,
            row: required_arg(&args, 1, "put row")?,
            column: required_arg(&args, 2, "put column")?,
            value: required_arg(&args, 3, "put value")?,
        }),
        "delete" => Ok(ShellCommand::Delete {
            table: required_arg(&args, 0, "delete table")?,
            row: required_arg(&args, 1, "delete row")?,
            column: required_arg(&args, 2, "delete column")?,
        }),
        "deleteall" => Ok(ShellCommand::DeleteAll {
            table: required_arg(&args, 0, "deleteall table")?,
            row: required_arg(&args, 1, "deleteall row")?,
        }),
        "count" => Ok(ShellCommand::Count {
            table: required_arg(&args, 0, "count table")?,
        }),
        "exists" => Ok(ShellCommand::Exists {
            table: required_arg(&args, 0, "exists table")?,
        }),
        "enable" => Ok(ShellCommand::Enable {
            table: required_arg(&args, 0, "enable table")?,
        }),
        "disable" => Ok(ShellCommand::Disable {
            table: required_arg(&args, 0, "disable table")?,
        }),
        "alter" => {
            let table = required_arg(&args, 0, "alter table")?;
            let families = args
                .iter()
                .skip(1)
                .map(|arg| parse_family_spec(arg))
                .collect::<Result<Vec<_>, _>>()?;
            if families.is_empty() {
                return Err("alter requires at least one column family specification".into());
            }
            Ok(ShellCommand::Alter { table, families })
        }
        other => Err(format!("Unsupported HBase shell command: {other}")),
    }
}

pub(super) fn split_command_name(value: &str) -> (&str, &str) {
    match value.find(char::is_whitespace) {
        Some(index) => (&value[..index], &value[index + 1..]),
        None => (value, ""),
    }
}

pub(super) fn required_arg(args: &[String], index: usize, label: &str) -> Result<String, String> {
    args.get(index)
        .map(|value| strip_quotes(value))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {label} argument"))
}

pub(super) fn parse_family_spec(input: &str) -> Result<FamilySpec, String> {
    let trimmed = input.trim();
    if trimmed.starts_with('{') {
        let opts = parse_options(trimmed)?;
        let name = opts
            .get("NAME")
            .cloned()
            .ok_or_else(|| "column family map requires NAME".to_string())?;
        let attributes = opts
            .into_iter()
            .filter(|(key, _)| key != "NAME")
            .collect::<BTreeMap<_, _>>();
        Ok(FamilySpec { name, attributes })
    } else {
        Ok(FamilySpec {
            name: strip_quotes(trimmed),
            attributes: BTreeMap::new(),
        })
    }
}

pub(super) fn parse_options(input: &str) -> Result<BTreeMap<String, String>, String> {
    let trimmed = input.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err(format!("Expected option map, got {trimmed}"));
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut out = BTreeMap::new();
    for item in split_top_level(inner, ',') {
        let Some((key, value)) = split_arrow(&item) else {
            continue;
        };
        out.insert(
            strip_quotes(&key).to_ascii_uppercase(),
            strip_quotes(&value),
        );
    }
    Ok(out)
}

pub(super) fn parse_columns_value(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        split_top_level(&trimmed[1..trimmed.len() - 1], ',')
            .into_iter()
            .map(|v| strip_quotes(&v))
            .filter(|v| !v.is_empty())
            .collect()
    } else {
        vec![strip_quotes(trimmed)]
    }
}

pub(super) fn split_arrow(input: &str) -> Option<(String, String)> {
    let mut single = false;
    let mut double = false;
    let chars = input.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i + 1 < chars.len() {
        match chars[i] {
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '=' if !single && !double && chars[i + 1] == '>' => {
                return Some((
                    chars[..i].iter().collect::<String>(),
                    chars[i + 2..].iter().collect::<String>(),
                ));
            }
            _ => {}
        }
        i += 1;
    }
    None
}

pub(super) fn split_top_level(input: &str, delimiter: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut single = false;
    let mut double = false;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut escaped = false;
    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && (single || double) {
            current.push(ch);
            escaped = true;
            continue;
        }
        match ch {
            '\'' if !double => {
                single = !single;
                current.push(ch);
            }
            '"' if !single => {
                double = !double;
                current.push(ch);
            }
            '{' if !single && !double => {
                brace_depth += 1;
                current.push(ch);
            }
            '}' if !single && !double => {
                brace_depth = brace_depth.saturating_sub(1);
                current.push(ch);
            }
            '[' if !single && !double => {
                bracket_depth += 1;
                current.push(ch);
            }
            ']' if !single && !double => {
                bracket_depth = bracket_depth.saturating_sub(1);
                current.push(ch);
            }
            ch if ch == delimiter
                && !single
                && !double
                && brace_depth == 0
                && bracket_depth == 0 =>
            {
                out.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

pub(super) fn strip_quotes(input: &str) -> String {
    let trimmed = input.trim();
    let quoted = (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'));
    if quoted && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1]
            .replace("\\'", "'")
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
    } else {
        trimmed.to_string()
    }
}
