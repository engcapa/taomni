//! File objects on NSPasteboard, not AppleScript's newline-delimited path text.

use super::super::clipboard::file_clipboard::{MAX_FILES, error, validate_paths};
use objc2::{
    ClassType,
    rc::{Retained, autoreleasepool},
    runtime::ProtocolObject,
    sel,
};
use objc2_app_kit::{
    NSPasteboard, NSPasteboardAccessBehavior, NSPasteboardTypeFileURL,
    NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSObjectProtocol, NSString, NSURL};

fn file_url(path: &str) -> Retained<NSURL> {
    // NSURL constructs a file URL but does not resolve symlinks.
    NSURL::fileURLWithPath(&NSString::from_str(path))
}

fn check_read_access(pasteboard: &NSPasteboard) -> Result<(), String> {
    // Newer macOS exposes a per-app pasteboard permission. Do not send an
    // unavailable selector on older supported systems, or treat denial as empty.
    if pasteboard.respondsToSelector(sel!(accessBehavior))
        && pasteboard.accessBehavior() == NSPasteboardAccessBehavior::AlwaysDeny
    {
        return Err(error(
            "permission_denied",
            "macOS pasteboard access is denied in System Settings",
        ));
    }
    Ok(())
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    let paths = read_files_raw()?;
    validate_paths(&paths)?;
    Ok(paths)
}

fn read_files_raw() -> Result<Vec<String>, String> {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        check_read_access(&pasteboard)?;
        let types = pasteboard
            .types()
            .ok_or_else(|| error("unavailable", "cannot enumerate macOS pasteboard types"))?;
        // Requiring a native file type prevents NSURL's conversions from treating
        // a plain-text file:///... string as a real copied file. Keep legacy
        // Finder NSFilenamesPboardType support through AppKit's NSURL reader.
        let has_files = types.iter().any(|kind| {
            kind.isEqualToString(unsafe { NSPasteboardTypeFileURL })
                || kind.isEqualToString(&NSString::from_str("NSFilenamesPboardType"))
        });
        if !has_files {
            return Ok(Vec::new());
        }
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let options = NSDictionary::from_slices(
            &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
            &[NSNumber::new_bool(true).as_ref()],
        );
        // SAFETY: The class array contains NSURL, which implements
        // NSPasteboardReading; the option is Apple's documented BOOL value.
        let objects = unsafe { pasteboard.readObjectsForClasses_options(&classes, Some(&options)) }
            .ok_or_else(|| error("unavailable", "macOS file objects could not be read"))?;
        if objects.len() > MAX_FILES {
            return Err(error(
                "invalid",
                format!("accepts at most {MAX_FILES} paths"),
            ));
        }
        let paths = objects
            .iter()
            .map(|object| {
                let url = object
                    .downcast::<NSURL>()
                    .map_err(|_| error("invalid", "pasteboard returned a non-URL object"))?;
                if !url.isFileURL() {
                    return Err(error("invalid", "pasteboard returned a non-file URL"));
                }
                if url.host().is_some_and(|host| {
                    let host = host.to_string();
                    !host.is_empty() && !host.eq_ignore_ascii_case("localhost")
                }) {
                    return Err(error(
                        "unsupported",
                        "remote file URL authority is not supported",
                    ));
                }
                url.path()
                    .map(|value| value.to_string())
                    .ok_or_else(|| error("invalid", "file URL has no filesystem path"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if paths.is_empty() {
            return Err(error("unavailable", "advertised macOS file list was empty"));
        }
        Ok(paths)
    })
}

pub fn clipboard_update_cut_files(
    expected: &[String],
    remaining: &[String],
) -> Result<bool, String> {
    validate_paths(remaining)?;
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        let generation = pasteboard.changeCount();
        if read_files_raw()? != expected || pasteboard.changeCount() != generation {
            return Ok(false);
        }
        if remaining.is_empty() {
            pasteboard.clearContents();
        } else {
            clipboard_write_files(remaining)?;
        }
        Ok(true)
    })
}

pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    validate_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    autoreleasepool(|_| {
        // arboard's macOS file_list canonicalizes each path internally. Construct
        // the same native NSURL objects directly so a directory symlink remains
        // the copied object. NSURL does not resolve symlinks in fileURLWithPath.
        let urls = paths
            .iter()
            .map(|path| ProtocolObject::<dyn NSPasteboardWriting>::from_retained(file_url(path)))
            .collect::<Vec<_>>();
        let objects = NSArray::from_retained_slice(&urls);
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if pasteboard.writeObjects(&objects) {
            Ok(())
        } else {
            Err(error("unavailable", "macOS rejected native file objects"))
        }
    })
}

#[cfg(test)]
#[path = "macos_file_clipboard_tests.rs"]
mod tests;
