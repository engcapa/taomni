use super::catalog::resolve_schema;
use super::connection::PanWeiClient;
use super::query::fetch;
use crate::database::ColumnDescription;
use crate::database::ForeignKeyInfo;
use crate::database::IndexInfo;
use crate::database::group_foreign_keys;

pub async fn describe_table(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = match fetch(
        client,
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
            COALESCE(pk.is_pk, false) AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
            SELECT kcu.column_name, true AS is_pk \
            FROM information_schema.table_constraints tc \
            JOIN information_schema.key_column_usage kcu \
              ON tc.constraint_name = kcu.constraint_name \
             AND tc.table_schema = kcu.table_schema \
            WHERE tc.constraint_type = 'PRIMARY KEY' \
              AND tc.table_schema = $1 AND tc.table_name = $2 \
         ) pk ON pk.column_name = c.column_name \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
        &[&schema_ref, &table],
    )
    .await
    {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) | Err(_) => {
            return describe_table_pg_catalog(client, schema_ref, table).await;
        }
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let type_name: String = row.try_get(1).unwrap_or_default();
            let nullable: String = row.try_get(2).unwrap_or_default();
            let default: Option<String> = row.try_get(3).ok().flatten();
            let primary_key: bool = row.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_foreign_keys(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = fetch(
        client,
        "SELECT fk.constraint_name, fk.column_name, pk.table_schema, \
                pk.table_name, pk.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage fk \
           ON fk.constraint_catalog = tc.constraint_catalog \
          AND fk.constraint_schema = tc.constraint_schema \
          AND fk.constraint_name = tc.constraint_name \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_catalog = tc.constraint_catalog \
          AND rc.constraint_schema = tc.constraint_schema \
          AND rc.constraint_name = tc.constraint_name \
         JOIN information_schema.key_column_usage pk \
           ON pk.constraint_catalog = rc.unique_constraint_catalog \
          AND pk.constraint_schema = rc.unique_constraint_schema \
          AND pk.constraint_name = rc.unique_constraint_name \
          AND pk.ordinal_position = fk.position_in_unique_constraint \
         WHERE tc.constraint_type = 'FOREIGN KEY' \
           AND tc.table_schema = $1 AND tc.table_name = $2 \
         ORDER BY fk.constraint_name, fk.ordinal_position",
        &[&schema_ref, &table],
    )
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            row.try_get(0).ok()?,
            row.try_get(1).ok()?,
            row.try_get(2).ok(),
            row.try_get(3).ok()?,
            row.try_get(4).ok()?,
        ))
    })))
}

pub(super) async fn describe_table_pg_catalog(
    client: &PanWeiClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let rows = fetch(
        client,
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
                EXISTS ( \
                    SELECT 1 \
                    FROM pg_catalog.pg_index i \
                    WHERE i.indrelid = c.oid \
                      AND i.indisprimary \
                      AND a.attnum = ANY(i.indkey) \
                ) AS is_pk \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        &[&schema, &table],
    )
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let type_name: String = row.try_get(1).unwrap_or_default();
            let nullable: bool = row.try_get(2).unwrap_or(true);
            let default: Option<String> = row.try_get(3).ok().flatten();
            let primary_key: bool = row.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_indexes(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let rows = fetch(
        client,
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
        &[&schema_ref, &table],
    )
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name: String = match row.try_get(0) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let column: String = row.try_get(1).unwrap_or_default();
        let unique: bool = row.try_get(2).unwrap_or(false);
        match grouped.iter_mut().find(|idx| idx.name == name) {
            Some(index) => index.columns.push(column),
            None => grouped.push(IndexInfo {
                name,
                columns: vec![column],
                unique,
            }),
        }
    }
    Ok(grouped)
}
