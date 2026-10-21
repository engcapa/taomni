mod stream;

pub use stream::*;

mod security;

mod writer;

pub use security::*;

#[cfg(test)]
mod tests;

use std::collections::VecDeque;

use std::io::{Error, ErrorKind, Read, Write};

use std::net::{TcpStream, ToSocketAddrs};

use std::sync::{Arc, Mutex};

use std::time::Duration;

use crate::vnc::clipboard::{
    ExtendedClipboardMsg, decode_legacy_cut_text, encode_legacy_cut_text,
    parse_extended_body_with_limits,
};

use crate::vnc::encodings::{
    self, DecodedCursor, DecodedPointerPosition, ENCODING_DESKTOP_SIZE, ENCODING_POINTER_POS,
    ENCODING_RICH_CURSOR, ENCODING_X_CURSOR, HextileState, ZrleDecoder,
};

use crate::vnc::framebuffer::{FbRect, Framebuffer, SharedFramebuffer};

use crate::vnc::limits::DecodeLimits;

use crate::vnc::pixel::{PixelConverter, PixelFormat};

use crate::vnc::policy::VncSecurityPolicy;

use crate::vnc::tight::{self, ENCODING_TIGHT, TightDecoder};

mod negotiation;

mod model;

mod connection;

mod handshake;

mod ard;

mod ra2;

mod runtime;

mod messages;

mod io;

pub(crate) use negotiation::{
    CREDENTIALS_REQUIRED, SEC_TYPE_ANONYMOUS_TLS, negotiate_protocol_version,
};

use negotiation::{
    ARD_FIELD_BYTES, ARD_MAX_KEY_BYTES, ARD_MIN_KEY_BYTES, RA2_AES_FRAME_MAX, RA2_MAX_KEY_BITS,
    RA2_MIN_KEY_BITS, RA2_SUBTYPE_PASS, RA2_SUBTYPE_USER_PASS, SEC_TYPE_ARD, SEC_TYPE_NONE,
    SEC_TYPE_RA2_128, SEC_TYPE_RA2_256, SEC_TYPE_RA2NE_128, SEC_TYPE_RA2NE_256, SEC_TYPE_VNC_AUTH,
    authentication_read_error, missing_password, needs_password,
};

pub use model::{RfbConnection, RfbWriter, ServerInit, ServerMessage};

pub(crate) use model::PendingSecurity;
