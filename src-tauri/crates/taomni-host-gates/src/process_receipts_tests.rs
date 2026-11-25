use super::*;

#[test]
fn concurrent_writers_publish_every_complete_identity_without_interleaving() {
    let owner = tempfile::tempdir().unwrap();
    let base = owner.path().join("processes.txt");
    let mut expected = Vec::new();
    std::thread::scope(|scope| {
        for pid in 1..=64 {
            let base = &base;
            let role = ["host", "hello", "child", "grandchild"][pid as usize % 4];
            expected.push((role.to_owned(), pid));
            scope.spawn(move || record(base, role, pid).unwrap());
        }
    });
    expected.sort();
    assert_eq!(read(&base).unwrap(), expected);
    assert_eq!(fs::read_dir(directory(&base)).unwrap().count(), 64);
}

#[test]
fn an_incomplete_writer_does_not_hide_already_published_processes() {
    let owner = tempfile::tempdir().unwrap();
    let base = owner.path().join("processes.txt");
    assert!(read(&base).unwrap().is_empty());
    record(&base, "host", 123).unwrap();
    fs::write(directory(&base).join(".child-456.partial"), "child ").unwrap();
    assert_eq!(read(&base).unwrap(), vec![("host".into(), 123)]);
    record(&base, "child", 456).unwrap();
    assert_eq!(
        read(&base).unwrap(),
        vec![("child".into(), 456), ("host".into(), 123)]
    );
}

#[test]
fn a_malformed_published_receipt_surfaces_instead_of_timing_out_as_missing() {
    let owner = tempfile::tempdir().unwrap();
    let base = owner.path().join("processes.txt");
    record(&base, "host", 123).unwrap();
    for invalid in ["host ", "host 456\n", "child 123\n", "host 0\n"] {
        fs::write(directory(&base).join("host-123.txt"), invalid).unwrap();
        assert_eq!(read(&base).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
    assert!(record(&base, "../foreign", 123).is_err());
    assert!(record(&base, "host", 0).is_err());
}
