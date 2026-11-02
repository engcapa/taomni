//! Screenshot image publication keeps the app-wide clipboard owner alive.
//! Windows may transiently deny OpenClipboard while another application reads
//! it. Retry only that typed busy condition; never hide a permanent failure.

use arboard::{Clipboard, Error, ImageData};
use image::RgbaImage;
use std::borrow::Cow;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// Cumulative typed busy retries. Isolated native QA compares before/after
// around one production IPC request; a timer alone cannot prove contention.
static BUSY_RETRIES: AtomicU64 = AtomicU64::new(0);

pub(super) fn busy_retries() -> u64 {
    BUSY_RETRIES.load(Ordering::Relaxed)
}

const RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(150),
];

fn retry_occupied<T>(
    mut operation: impl FnMut() -> Result<T, Error>,
    mut wait: impl FnMut(Duration),
) -> Result<T, Error> {
    let mut delays = RETRY_DELAYS.into_iter();
    loop {
        match operation() {
            Err(Error::ClipboardOccupied) => match delays.next() {
                Some(delay) => wait(delay),
                None => return Err(Error::ClipboardOccupied),
            },
            result => return result,
        }
    }
}

/// Used from a blocking worker. Retain the same decoded image over retries;
/// release the application's mutex before sleeping so other owners can finish.
pub(super) fn publish(
    clipboard: &Mutex<Option<Clipboard>>,
    image: &RgbaImage,
) -> anyhow::Result<()> {
    let result = retry_occupied(
        || {
            let mut guard = clipboard.lock().map_err(|_| Error::Unknown {
                description: "application clipboard lock poisoned".into(),
            })?;
            if guard.is_none() {
                *guard = Some(Clipboard::new()?);
            }
            guard
                .as_mut()
                .expect("clipboard initialized")
                .set_image(ImageData {
                    width: image.width() as usize,
                    height: image.height() as usize,
                    bytes: Cow::Borrowed(image.as_raw()),
                })
        },
        |delay| {
            BUSY_RETRIES.fetch_add(1, Ordering::Relaxed);
            std::thread::sleep(delay);
        },
    );
    result.map_err(|error| {
        log::warn!("screenshot clipboard publication failed: {error}");
        anyhow::anyhow!("write image to clipboard: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_open_contention_succeeds_from_one_copy_request() {
        let mut attempts = 0;
        let mut waited = Vec::new();
        let result = retry_occupied(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(Error::ClipboardOccupied)
                } else {
                    Ok("same image")
                }
            },
            |delay| waited.push(delay),
        );
        assert_eq!(result.unwrap(), "same image");
        assert_eq!(attempts, 3);
        assert_eq!(waited, RETRY_DELAYS[..2]);
    }

    #[test]
    fn permanent_failure_is_not_retried_and_busy_has_a_finite_budget() {
        let mut attempts = 0;
        let result: Result<(), _> = retry_occupied(
            || {
                attempts += 1;
                Err(Error::ConversionFailure)
            },
            |_| panic!("permanent errors must not sleep"),
        );
        assert!(matches!(result, Err(Error::ConversionFailure)));
        assert_eq!(attempts, 1);
        let mut waits = 0;
        let busy: Result<(), _> = retry_occupied(|| Err(Error::ClipboardOccupied), |_| waits += 1);
        assert!(matches!(busy, Err(Error::ClipboardOccupied)));
        assert_eq!(waits, RETRY_DELAYS.len());
    }
}
