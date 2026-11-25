//! CLIPRDR clipboard bridge for the RDP server.
//!
//! Bridges the host OS clipboard (`arboard`) and the RDP client's clipboard in
//! both directions under a per-direction policy (DEC-10, [`ClipboardLevel`]):
//! `text` carries `CF_UNICODETEXT`, `rich` adds CF_HTML and CF_DIB/CF_DIBV5
//! images, `all` adds files (`FileGroupDescriptorW` + `FileContents`).
//!
//! Ownership:
//! - One host worker thread per running server owns the `arboard::Clipboard`
//!   (on X11 the data we publish only lives as long as that instance), detects
//!   host changes and performs every host write.
//! - The per-connection [`ClipboardBackend`] runs on the server reactor thread;
//!   it never touches arboard and never waits for the worker.
//!
//! host → client: the worker notices a change (Windows clipboard sequence
//! number, macOS pasteboard change count, XFixes selection events on X11,
//! content polling otherwise), snapshots the allowed formats and advertises
//! them. Format data and file ranges are then served from that snapshot.
//!
//! client → host: a remote format list is fetched eagerly, one format at a
//! time, because arboard has no cross-platform delayed rendering; files are
//! downloaded into a private staging directory before the worker publishes
//! them (DEC-11).
//!
//! Echo suppression (DEC-15): clipboard states are compared by identity (text,
//! image pixels, file names and sizes), so a client on the same machine, which
//! shares this OS clipboard, cannot drive an endless announce/fetch loop.

mod limits;

mod policy;

mod host_content;

mod change_token;

mod host_poll;

mod files;

mod shared;

mod worker;

mod requests;

mod download;

mod backend;

#[cfg(test)]
mod tests;

pub(crate) use policy::ClipboardPolicy;

pub(crate) use worker::ClipboardFactory;
