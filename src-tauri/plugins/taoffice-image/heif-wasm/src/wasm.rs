use std::cell::RefCell;

use crate::{Thumbnail, decode_thumbnail};

const MAX_BYTES: usize = 32 * 1024 * 1024;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESULT: RefCell<Option<Thumbnail>> = const { RefCell::new(None) };
}

// The worker copies one file into exported linear memory before calling decode.
// Only this Wasm instance owns the input and result allocations.
#[unsafe(no_mangle)]
pub extern "C" fn heif_input(length: usize) -> *mut u8 {
    let mut bytes = Vec::new();
    if length == 0 || length > MAX_BYTES || bytes.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
    bytes.resize(length, 0);
    let ptr = bytes.as_mut_ptr();
    INPUT.set(bytes);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn heif_decode() -> u32 {
    RESULT.set(None);
    match decode_thumbnail(&INPUT.take()) {
        Ok(output) => {
            RESULT.set(Some(output));
            0
        }
        Err(error) => error as u32,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn heif_png() -> *const u8 {
    RESULT.with_borrow(|output| {
        output
            .as_ref()
            .map_or(std::ptr::null(), |value| value.png.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn heif_png_length() -> usize {
    RESULT.with_borrow(|output| output.as_ref().map_or(0, |value| value.png.len()))
}

#[unsafe(no_mangle)]
pub extern "C" fn heif_width() -> u32 {
    RESULT.with_borrow(|output| output.as_ref().map_or(0, |value| value.width))
}

#[unsafe(no_mangle)]
pub extern "C" fn heif_height() -> u32 {
    RESULT.with_borrow(|output| output.as_ref().map_or(0, |value| value.height))
}
