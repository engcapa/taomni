# hello-plugin

This is the minimal out-of-process plugin fixture for the M0 G gates. It has
no Tauri or application dependency and uses the stable `taomni-plugin-api`
JSON-RPC contract over newline-delimited stdin/stdout.

Set `TAOMNI_PLUGIN_TOKEN` before starting the host. The core sends a
`plugin/handshake` request whose params are a `HandshakeRequest`, then may use
`plugin/enable`, `plugin/disable`, and `hello/ping`. `hello/crash` exits with
status 70 and `hello/hang` intentionally withholds a response for the
configured duration (`TAOMNI_HELLO_HANG_MS`, default 60 seconds) so a host can
verify crash cleanup and request timeout handling.

Run the fixture contract locally with:

```text
cargo test --manifest-path src-tauri/plugins/hello-plugin/Cargo.toml --locked
```
