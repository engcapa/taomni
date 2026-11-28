use super::*;

const LINKED_TASKS: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/linked-tasks.mpp");

#[test]
fn converts_binary_task_dates_calendars_links_and_assignments() {
    let xml = mpp_to_mspdi(LINKED_TASKS, || Ok(())).unwrap();
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
fn rejects_invalid_and_over_limit_input_and_can_cancel_an_import() {
    assert!(mpp_to_mspdi(b"Not a project file", || Ok(())).is_err());
    assert!(mpp_to_mspdi(&vec![0; MAX_BYTES + 1], || Ok(())).is_err());
    assert_eq!(
        mpp_to_mspdi(LINKED_TASKS, || Err("cancelled".into())).unwrap_err(),
        "cancelled"
    );
}
