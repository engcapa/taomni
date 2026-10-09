# tauri-utils

Source: crates.io `tauri-utils` 2.10.1, refreshed with the Tauri 2.12 Windows
input-deadlock fix. `.cargo_vcs_info.json` records the upstream source revision.

Local patch retained from `b3e635bf`: reject non-ASCII hex characters before
`Color::from_str` slices UTF-8 at byte offsets. The regression test
`parse_hex_color_rejects_invalid_unicode_without_panicking` is also retained;
upstream 2.10.1 still lacks this guard. Keep this patch when refreshing the vendor.
