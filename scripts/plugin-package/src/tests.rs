use super::*;

fn payload(root: &Path, platform: &str) {
    fs::create_dir_all(root.join("frontend")).unwrap();
    let host = if platform.starts_with("windows") {
        "host.exe"
    } else {
        "host"
    };
    fs::write(
        root.join("module.json"),
        serde_json::to_vec(&json!({
            "id": "taomni-plugin-test", "slug": "test", "version": "1.0.0", "coreApiVersion": "1",
            "platforms": [platform], "entry": {"host": host, "frontend": "frontend/index.js"},
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(root.join(host), b"unit-only host bytes; never executed").unwrap();
    fs::write(
        root.join("frontend/index.js"),
        b"export const test = true;\n",
    )
    .unwrap();
}

#[test]
fn packages_exact_checksums_executable_mode_and_version_bound_signature_for_every_platform() {
    for platform in PLATFORMS {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("payload");
        payload(&input, platform);
        let output = dir.path().join("output");
        let receipt = package(
            &input,
            platform,
            &output,
            &"a".repeat(40),
            &ReleaseSigner::test_key(),
        )
        .unwrap();
        let name = receipt["archive"].as_str().unwrap();
        assert_eq!(sha256(&output.join(name)).unwrap(), receipt["sha256"]);
        let signature = fs::read_to_string(output.join(format!("{name}.minisig"))).unwrap();
        assert!(signature.contains(&format!("platform={platform} coreApiVersion=1 sha256=")));
        let mut zip = zip::ZipArchive::new(File::open(output.join(name)).unwrap()).unwrap();
        assert_eq!(zip.len(), 4);
        let host = if platform.starts_with("windows") {
            "host.exe"
        } else {
            "host"
        };
        assert_eq!(
            zip.by_name(host).unwrap().unix_mode().unwrap() & 0o777,
            0o755
        );
        let mut sums = String::new();
        zip.by_name("SHA256SUMS")
            .unwrap()
            .read_to_string(&mut sums)
            .unwrap();
        assert_eq!(sums.lines().count(), 3);
        for line in sums.lines() {
            let (hash, name) = line.split_once("  ").unwrap();
            let mut bytes = Vec::new();
            zip.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(bytes)), hash);
        }
        assert_eq!(fs::read_dir(output).unwrap().count(), 5);
    }
}

#[test]
fn rejects_missing_entries_wrong_platform_reserved_paths_and_output_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("payload");
    payload(&input, "linux-x86_64");
    let output = dir.path().join("out");
    let signer = ReleaseSigner::test_key();
    let source = "b".repeat(40);
    assert!(package(&input, "windows-x86_64", &output, &source, &signer).is_err());
    fs::remove_file(input.join("host")).unwrap();
    assert!(package(&input, "linux-x86_64", &output, &source, &signer).is_err());
    fs::write(input.join("host"), "host").unwrap();
    fs::write(input.join("SHA256SUMS"), "caller-defined").unwrap();
    assert!(package(&input, "linux-x86_64", &output, &source, &signer).is_err());
    fs::remove_file(input.join("SHA256SUMS")).unwrap();
    fs::write(input.join("HOST"), "alias").unwrap();
    assert!(package(&input, "linux-x86_64", &output, &source, &signer).is_err());
    fs::remove_file(input.join("HOST")).unwrap();
    package(&input, "linux-x86_64", &output, &source, &signer).unwrap();
    assert!(package(&input, "linux-x86_64", &output, &source, &signer).is_err());
}

#[test]
fn portable_paths_cannot_disagree_with_native_archive_validation() {
    for path in [
        "../host",
        "host:stream",
        "frontend/CON.js",
        "LPT1",
        "COM9.txt",
        "name.",
        "name ",
        ".taomni-trust/file",
        "SHA256SUMS",
    ] {
        assert!(safe_name(Path::new(path)).is_err(), "accepted {path}");
    }
    assert!(safe_name(Path::new("frontend/chunks/hello.js")).is_ok());
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_files_before_signing() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("payload");
    payload(&input, "linux-x86_64");
    std::os::unix::fs::symlink("host", input.join("link")).unwrap();
    assert!(
        package(
            &input,
            "linux-x86_64",
            &dir.path().join("out"),
            &"a".repeat(40),
            &ReleaseSigner::test_key()
        )
        .is_err()
    );
}
