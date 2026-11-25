mod model;

mod cursor;

mod pixels;

mod raw;

mod hextile;

mod zrle;

#[cfg(test)]
mod tests;

pub use model::{
    DecodedCursor, DecodedPointerPosition, ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS,
    ENCODING_RICH_CURSOR, ENCODING_X_CURSOR,
};

pub use cursor::{read_rich_cursor, read_x_cursor};

pub(crate) use pixels::rgb_to_rgba;

pub use raw::{decode_raw_into, read_copyrect_source};

pub use hextile::{HextileState, decode_hextile_into};

pub use zrle::{ZrleDecoder, decode_zrle_into};
