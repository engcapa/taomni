//! Windows readers and virus scanners can briefly deny an atomic replacement.
use std::io;
use std::time::{Duration, Instant};

pub(crate) fn retry<T>(replace: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry_until(replace, Instant::now() + Duration::from_secs(2))
}

fn retry_until<T>(mut replace: impl FnMut() -> io::Result<T>, deadline: Instant) -> io::Result<T> {
    loop {
        match replace() {
            Err(error) if transient_denial(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            result => return result,
        }
    }
}

fn transient_denial(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(test)]
#[path = "atomic_replace_tests.rs"]
mod tests;
