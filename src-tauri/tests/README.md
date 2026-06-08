# Backend tests

Unit tests live inline in each module (`#[cfg(test)]`); integration tests live
in this directory. Run everything that needs no external services with:

```bash
cargo test
```

## Network / proxy / SSH jump-host tests

The proxy-handshake tests are **self-contained** and run by default: they spin
up an in-process SOCKS5 / HTTP CONNECT proxy and a loopback echo server, then
drive the real client handshake through them. No configuration needed.

- `terminal::network::tests::socks5_handshake_round_trips_through_real_proxy`
- `terminal::network::tests::http_connect_handshake_round_trips_through_real_proxy`
- `terminal::network::tests::socks5_handshake_with_username_password_auth`
- `database::forward::tests::loopback_forward_bridges_through_socks5_to_target`

## Live tests (opt-in, real SSH server)

Tests that reach a real SSH server are marked `#[ignore]` and **skip silently**
when their environment variables are unset. They never contain hard-coded
credentials — everything comes from the environment.

Run them explicitly with:

```bash
cargo test -- --ignored
```

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `TAOMNI_LIVE_SSH_HOST` | SSH server host | (required) |
| `TAOMNI_LIVE_SSH_USER` | SSH username | (required) |
| `TAOMNI_LIVE_SSH_PASSWORD` | SSH password | (required) |
| `TAOMNI_LIVE_SSH_PORT` | SSH port | `22` |
| `TAOMNI_INTERNAL_HOST` | Host reachable *through* the jump host (for the jump-host test) | (required for that test) |
| `TAOMNI_INTERNAL_PORT` | Port on the internal host | `22` |
| `TAOMNI_INTERNAL_USER` | Username on the internal host | falls back to `TAOMNI_LIVE_SSH_USER` |
| `TAOMNI_INTERNAL_PASSWORD` | Password on the internal host | falls back to `TAOMNI_LIVE_SSH_PASSWORD` |

### What each live test covers

- `terminal::ssh::tests::live_ssh_through_socks5_proxy` — authenticates to the
  live SSH server through an in-process SOCKS5 proxy (Strategy 2: proxy → real
  SSH end-to-end).
- `terminal::ssh::tests::live_ssh_through_jump_host` — connects to
  `TAOMNI_INTERNAL_HOST` *through* the live SSH server acting as a jump host.
- `terminal::ssh::tests::live_terminal_survives_vi_quit_and_followup_input` —
  pre-existing terminal smoke test.

> Strategy 3 (a real third-party HTTP/SOCKS5 proxy via `TAOMNI_PROXY_*`) is not
> wired up yet — add it once a proxy is available in the test environment.
