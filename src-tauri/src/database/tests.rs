use super::{
    DEFAULT_METADATA_SEARCH_LIMIT, MAX_METADATA_SEARCH_LIMIT, group_foreign_keys,
    metadata_search_limit,
};

#[test]
fn metadata_search_limits_are_bounded() {
    assert_eq!(metadata_search_limit(None), DEFAULT_METADATA_SEARCH_LIMIT);
    assert_eq!(metadata_search_limit(Some(0)), 1);
    assert_eq!(metadata_search_limit(Some(25)), 25);
    assert_eq!(
        metadata_search_limit(Some(u32::MAX)),
        MAX_METADATA_SEARCH_LIMIT
    );
}

#[test]
fn groups_composite_foreign_key_columns_in_order() {
    let foreign_keys = group_foreign_keys(
        vec![
            (
                "orders_account_fk".to_string(),
                "account_id".to_string(),
                Some("public".to_string()),
                "accounts".to_string(),
                "id".to_string(),
            ),
            (
                "orders_account_fk".to_string(),
                "tenant_id".to_string(),
                Some("public".to_string()),
                "accounts".to_string(),
                "tenant_id".to_string(),
            ),
        ]
        .into_iter(),
    );

    assert_eq!(foreign_keys.len(), 1);
    assert_eq!(foreign_keys[0].columns, ["account_id", "tenant_id"]);
    assert_eq!(foreign_keys[0].referenced_columns, ["id", "tenant_id"]);
}
