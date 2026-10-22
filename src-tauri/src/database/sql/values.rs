use sqlx_core::column::Column;
use sqlx_core::row::Row;
use sqlx_core::type_info::TypeInfo;
use sqlx_core::types::BigDecimal;
use sqlx_core::types::Uuid;
use sqlx_mysql::MySqlRow;
use sqlx_postgres::PgRow;
use tiberius::ColumnType as TdsColumnType;
use tiberius::Row as TdsRow;

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

/// Decode the i-th column of a MySQL row to an optional display string. The
/// column's SQL type name drives which concrete `try_get` is attempted, with a
/// raw-bytes / lossy-utf8 fallback so unknown types never panic.
pub(super) fn mysql_value_to_string(row: &MySqlRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOLEAN" | "BOOL" => try_as!(bool),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" => try_as!(i64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            try_as!(u64)
        }
        "BIGINT" => try_as!(i64),
        "FLOAT" => try_as!(f32),
        "DOUBLE" | "REAL" => try_as!(f64),
        "DECIMAL" | "NUMERIC" => try_as!(BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "DATETIME" | "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "JSON" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        "BIT" => {
            if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
                return v.map(|x| x.to_string());
            }
            if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return v.map(|b| {
                    if b.is_empty() {
                        "0".to_string()
                    } else if b.len() == 1 {
                        b[0].to_string()
                    } else {
                        let mut val: u64 = 0;
                        for &byte in &b {
                            val = (val << 8) | (byte as u64);
                        }
                        val.to_string()
                    }
                });
            }
        }
        _ => {}
    }
    // Fallback: text, then raw bytes (lossy utf8 for BLOB/VARBINARY).
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

/// Decode the i-th column of a PostgreSQL row to an optional display string.
pub(super) fn pg_value_to_string(row: &PgRow, i: usize) -> Option<String> {
    let col = &row.columns()[i];
    let type_name = col.type_info().name().to_uppercase();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<Option<$t>, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match type_name.as_str() {
        "BOOL" => try_as!(bool),
        "INT2" => try_as!(i16),
        "INT4" => try_as!(i32),
        "INT8" => try_as!(i64),
        "FLOAT4" => try_as!(f32),
        "FLOAT8" => try_as!(f64),
        "NUMERIC" => try_as!(BigDecimal),
        "DATE" => try_as!(chrono::NaiveDate),
        "TIME" => try_as!(chrono::NaiveTime),
        "TIMESTAMP" => try_as!(chrono::NaiveDateTime),
        "TIMESTAMPTZ" => try_as!(chrono::DateTime<chrono::Utc>),
        "UUID" => try_as!(Uuid),
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

pub(super) fn sqlserver_column_type_name(kind: TdsColumnType) -> &'static str {
    match kind {
        TdsColumnType::Null => "null",
        TdsColumnType::Bit | TdsColumnType::Bitn => "bit",
        TdsColumnType::Int1 => "tinyint",
        TdsColumnType::Int2 => "smallint",
        TdsColumnType::Int4 => "int",
        TdsColumnType::Int8 => "bigint",
        TdsColumnType::Intn => "int",
        TdsColumnType::Float4 => "real",
        TdsColumnType::Float8 | TdsColumnType::Floatn => "float",
        TdsColumnType::Money | TdsColumnType::Money4 => "money",
        TdsColumnType::Decimaln => "decimal",
        TdsColumnType::Numericn => "numeric",
        TdsColumnType::Datetime | TdsColumnType::Datetime4 | TdsColumnType::Datetimen => "datetime",
        TdsColumnType::Daten => "date",
        TdsColumnType::Timen => "time",
        TdsColumnType::Datetime2 => "datetime2",
        TdsColumnType::DatetimeOffsetn => "datetimeoffset",
        TdsColumnType::Guid => "uniqueidentifier",
        TdsColumnType::BigVarBin | TdsColumnType::BigBinary => "varbinary",
        TdsColumnType::BigVarChar | TdsColumnType::BigChar | TdsColumnType::Text => "varchar",
        TdsColumnType::NVarchar | TdsColumnType::NChar | TdsColumnType::NText => "nvarchar",
        TdsColumnType::Xml => "xml",
        TdsColumnType::Udt => "udt",
        TdsColumnType::Image => "image",
        TdsColumnType::SSVariant => "sql_variant",
    }
}

pub(super) fn sqlserver_value_to_string(row: &TdsRow, i: usize) -> Option<String> {
    let kind = row.columns()[i].column_type();
    macro_rules! try_as {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<$t, _>(i) {
                return v.map(|x| x.to_string());
            }
        };
    }
    match kind {
        TdsColumnType::Bit | TdsColumnType::Bitn => try_as!(bool),
        TdsColumnType::Int1 => try_as!(u8),
        TdsColumnType::Int2 => try_as!(i16),
        TdsColumnType::Int4 | TdsColumnType::Intn => try_as!(i32),
        TdsColumnType::Int8 => try_as!(i64),
        TdsColumnType::Float4 => try_as!(f32),
        TdsColumnType::Float8 | TdsColumnType::Floatn => try_as!(f64),
        TdsColumnType::Decimaln
        | TdsColumnType::Numericn
        | TdsColumnType::Money
        | TdsColumnType::Money4 => {
            try_as!(tiberius::numeric::Numeric)
        }
        TdsColumnType::Guid => try_as!(Uuid),
        TdsColumnType::Daten => try_as!(chrono::NaiveDate),
        TdsColumnType::Timen => try_as!(chrono::NaiveTime),
        TdsColumnType::Datetime
        | TdsColumnType::Datetime4
        | TdsColumnType::Datetimen
        | TdsColumnType::Datetime2 => try_as!(chrono::NaiveDateTime),
        TdsColumnType::DatetimeOffsetn => try_as!(chrono::DateTime<chrono::FixedOffset>),
        TdsColumnType::Xml => {
            if let Ok(v) = row.try_get::<&tiberius::xml::XmlData, _>(i) {
                return v.map(|x| x.to_string());
            }
        }
        _ => {}
    }
    if let Ok(v) = row.try_get::<&str, _>(i) {
        return v.map(|x| x.to_string());
    }
    if let Ok(v) = row.try_get::<&[u8], _>(i) {
        return v.map(|b| String::from_utf8_lossy(b).into_owned());
    }
    None
}
