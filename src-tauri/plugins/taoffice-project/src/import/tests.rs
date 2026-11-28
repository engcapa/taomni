use super::*;

const LINKED_TASKS: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/linked-tasks.mpp");

#[test]
fn converts_binary_task_dates_calendars_links_and_assignments() {
    let xml = import_to_mspdi(LINKED_TASKS, || Ok(())).unwrap();
    let xml = std::str::from_utf8(&xml).unwrap();
    assert!(xml.contains(r#"<Project xmlns="http://schemas.microsoft.com/project">"#));
    assert_eq!(xml.matches("<Task>").count(), 17);
    assert_eq!(xml.matches("<PredecessorLink>").count(), 8);
    assert_eq!(xml.matches("<Assignment>").count(), 16);
    assert_eq!(xml.matches("<ResourceUID>-65535</ResourceUID>").count(), 16);
    assert!(xml.contains("<Name>Standard</Name>"));
    let task = xml
        .split("<Task><UID>2</UID>")
        .nth(1)
        .unwrap()
        .split("</Task>")
        .next()
        .unwrap();
    assert!(task.contains("<Start>2014-10-30T08:00:00</Start>"));
    assert!(task.contains("<PredecessorUID>1</PredecessorUID><Type>1</Type>"));
}

#[test]
fn imports_project_98_exchange_tasks_and_links() {
    let source =
        include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/linked-tasks.mpx");
    let bytes = import_to_mspdi(source, || Ok(())).unwrap();
    let xml = std::str::from_utf8(&bytes).unwrap();
    assert_eq!(xml.matches("<Task>").count(), 17);
    assert_eq!(xml.matches("<PredecessorLink>").count(), 8);
    assert!(xml.contains("<Name>task-links-project98</Name>"));
    let task = xml
        .split("<Task><UID>2</UID>")
        .nth(1)
        .unwrap()
        .split("</Task>")
        .next()
        .unwrap();
    assert!(task.contains("<Start>2014-10-20T00:00:00</Start>"));
    assert!(task.contains("<PredecessorUID>1</PredecessorUID><Type>1</Type>"));
    assert!(import_to_mspdi(b"MPX", || Ok(())).is_err());
}

#[test]
fn reads_localized_exchange_columns_and_lag_from_the_file() {
    let source =
        include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/exchange-de.mpx");
    let bytes = import_to_mspdi(source, || Ok(())).unwrap();
    let xml = std::str::from_utf8(&bytes).unwrap();
    assert_eq!(xml.matches("<Task>").count(), 20);
    assert_eq!(xml.matches("<PredecessorLink>").count(), 6);
    assert!(
        xml.contains("<PredecessorUID>11</PredecessorUID><Type>1</Type><LinkLag>4800</LinkLag>")
    );
    assert!(xml.contains("<Start>2003-01-09T00:00:00</Start>"));
}

#[test]
fn rejects_invalid_and_over_limit_input_and_can_cancel_an_import() {
    assert!(import_to_mspdi(b"Not a project file", || Ok(())).is_err());
    assert!(import_to_mspdi(&vec![0; MAX_BYTES + 1], || Ok(())).is_err());
    assert_eq!(
        import_to_mspdi(LINKED_TASKS, || Err("cancelled".into())).unwrap_err(),
        "cancelled"
    );
}
