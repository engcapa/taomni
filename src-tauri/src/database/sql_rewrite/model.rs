use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlRewriteRequest {
    pub engine: String,
    pub source_sql: String,
    pub result_columns: Vec<String>,
    #[serde(default)]
    pub visible_column_indexes: Vec<usize>,
    #[serde(default)]
    pub global_filter_text: String,
    #[serde(default)]
    pub filters: Vec<ResultSqlFilter>,
    #[serde(default)]
    pub sorts: Vec<ResultSqlSort>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlFilter {
    pub column_index: usize,
    #[serde(default)]
    pub text: String,
    pub mode: ResultSqlFilterMode,
    #[serde(default)]
    pub selected_values: Vec<Option<String>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlFilterMode {
    Fuzzy,
    Exact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlSort {
    pub column_index: usize,
    pub dir: ResultSqlSortDir,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlSortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlRewriteResponse {
    pub sql: Option<String>,
    pub mode: ResultSqlRewriteMode,
    pub reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlRewriteMode {
    Inline,
    Unsupported,
}

#[derive(Debug, Clone)]
pub(super) enum ProjectionMapping {
    Source(String),
    Computed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResultSqlEngine {
    MySql,
    StarRocks,
    PostgreSql,
    PanWeiDb,
    Oracle,
    SqlServer,
    ClickHouse,
    Presto,
}

impl ResultSqlEngine {
    pub(super) fn parse(value: &str) -> Self {
        match value {
            "PostgreSQL" => Self::PostgreSql,
            "PanWeiDB" => Self::PanWeiDb,
            "Oracle" => Self::Oracle,
            "SQLServer" => Self::SqlServer,
            "StarRocks" => Self::StarRocks,
            "ClickHouse" => Self::ClickHouse,
            "Presto" => Self::Presto,
            _ => Self::MySql,
        }
    }

    pub(super) fn quote_ident(self, ident: &str) -> String {
        match self {
            Self::SqlServer => format!("[{}]", ident.replace(']', "]]")),
            Self::PostgreSql | Self::PanWeiDb | Self::Oracle | Self::Presto => {
                format!("\"{}\"", ident.replace('"', "\"\""))
            }
            Self::MySql | Self::StarRocks | Self::ClickHouse => {
                format!("`{}`", ident.replace('`', "``"))
            }
        }
    }

    pub(super) fn text_expression(self, expression: &str) -> String {
        match self {
            Self::MySql | Self::StarRocks => format!("CAST({expression} AS CHAR)"),
            Self::PostgreSql | Self::PanWeiDb => format!("{expression}::text"),
            Self::Oracle => format!("CAST({expression} AS VARCHAR2(4000))"),
            Self::SqlServer => format!("CAST({expression} AS NVARCHAR(MAX))"),
            Self::ClickHouse => format!("toString({expression})"),
            Self::Presto => format!("CAST({expression} AS VARCHAR)"),
        }
    }
}
