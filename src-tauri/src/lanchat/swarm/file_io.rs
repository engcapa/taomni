/* --------------------------- positioned file IO --------------------------- */
// Positioned reads/writes (no shared cursor) so a node can serve already-held
// pieces while still writing newly received ones. Blocking — run via
// `spawn_blocking`.

#[cfg(unix)]
pub(super) fn pread_exact(f: &std::fs::File, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::os::unix::fs::FileExt;
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = f.read_at(&mut buf[done..], off + done as u64)?;
        if n == 0 {
            break;
        }
        done += n;
    }
    buf.truncate(done);
    Ok(buf)
}

#[cfg(windows)]
pub(super) fn pread_exact(f: &std::fs::File, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::os::windows::fs::FileExt;
    let mut buf = vec![0u8; len];
    let mut done = 0;
    while done < len {
        let n = f.seek_read(&mut buf[done..], off + done as u64)?;
        if n == 0 {
            break;
        }
        done += n;
    }
    buf.truncate(done);
    Ok(buf)
}

#[cfg(unix)]
pub(super) fn pwrite_all(f: &std::fs::File, off: u64, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    let mut done = 0;
    while done < data.len() {
        let n = f.write_at(&data[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "write_at returned 0",
            ));
        }
        done += n;
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn pwrite_all(f: &std::fs::File, off: u64, data: &[u8]) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < data.len() {
        let n = f.seek_write(&data[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "seek_write returned 0",
            ));
        }
        done += n;
    }
    Ok(())
}
