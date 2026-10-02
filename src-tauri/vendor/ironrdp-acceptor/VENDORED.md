# ironrdp-acceptor 0.10.0

Source: crates.io `ironrdp-acceptor` 0.10.0, MIT OR Apache-2.0.

Local patch: retain the Client Info `INFO_COMPRESSION` flag and compression
level in `AcceptorResult::client_compression`, for TLS and HYBRID alike. Preserve
the value through Deactivation-Reactivation, which does not resend Client Info.
No authentication policy changes.
