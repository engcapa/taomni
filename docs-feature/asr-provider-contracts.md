# Realtime ASR contracts (2026-10-08)

Implementation: `src-tauri/src/voice/{streaming,providers,vocabulary}.rs`.
All four supported providers emit the same `TranscriptEvent`. Credentials use
the existing vault path. Application/custom/direct proxy selection is shared;
direct opens its own TCP connection and vocabulary HTTP clients disable ambient
proxies. Configured proxy errors never cause direct fallback.

| Provider | Connection and completion | Neutral hotwords |
|---|---|---|
| Deepgram | Nova-3; Token auth; PCM16/16kHz/mono; CloseStream, final Results, then Metadata | Repeated `keyterm` query values |
| Aliyun | Paraformer realtime v2; Bearer auth; run-task → task-started → PCM → finish-task → task-finished | Managed speech-biasing vocabulary, workspace HTTPS endpoint required |
| Soniox | Current `stt-rt-v5`; Bearer auth; initial JSON then PCM; empty **text** end frame; drain `finished: true` | `context.terms`; mixed final/nonfinal tokens separated |
| Volcengine | New-console X-Api-Key, resource ID and connection/request IDs; `bigmodel_async`; gzip binary frames; last-audio and final-response flags | Managed CreateBoostingTable multipart request; application ID required |

The vocabulary limit is 2,000 normalized distinct terms. Invalid control
characters and overlong terms are rejected, not silently truncated. Aliyun's
additional term-length limits are validated. Remote vocabulary IDs are cached
by provider/model/workspace/app/key/word fingerprint; plaintext keys and terms
are not written into that cache. A removed remote vocabulary currently requires
changing/resaving terms or clearing the corresponding cache entry before retry.
No unverified local-engine hotword support is advertised.

Every dictation owns one socket. Five seconds of silence or missing input closes
audio forwarding and allows up to 15 seconds for final acknowledgement. Explicit
cancel drops the backend future/socket immediately and invalidates frontend
results. Premature disconnects report an `ASR_*` error. Silence is a simple RMS
guard, not a claimed calibrated VAD or billing guarantee; noisy environments are
still bounded by the existing 120-second PTT limit.

Gemini Live remains experimental, hidden by default. Its legacy protocol is not
part of the four-provider acceptance claim and has no live validation here.
No provider price or billing logic is implemented. Current account pricing and
actual session charges require console verification; the plan's unverified
prices are not copied into product behavior.

## Sources checked

- [Soniox WebSocket API](https://soniox.com/docs/stt/api-reference/websocket-api): current model, authentication, tokens and empty-text completion.
- [Volcengine streaming API](https://www.volcengine.com/docs/6561/1354869): async endpoint, new-console API-key authentication, header flags, gzip and cumulative utterances.
- [Volcengine hotword API](https://www.volcengine.com/docs/6561/1742791): API-key proxy endpoint, multipart CreateBoostingTable and newline term files.
- [Aliyun vocabulary HTTP API](https://help.aliyun.com/zh/model-studio/vocabulary-http-api): workspace endpoint, speech-biasing request and vocabulary ID.
- [Deepgram CloseStream](https://developers.deepgram.com/docs/close-stream): drain buffered transcription before closing the session.

Official documentation was retrieved on 2026-10-08. These are protocol sources,
not evidence of successful authenticated calls from this installation.

## Evidence boundaries

Native loopback WebSocket fixtures cover delayed finals, completion frames,
Volcengine gzip/sequence/size/error validation, cumulative deduplication and
early disconnects. Direct TCP, HTTP CONNECT and SOCKS5 handshakes are exercised
with real sockets. Native HTTP vocabulary fixtures verify successful IDs and
rejected/malformed responses without exposing response secrets in errors.

TC-VOICE-005/008 cover settings, persistence and provider selection in the
browser. These use stubs and do not establish cloud reachability, live pricing,
TLS proxy operation or vendor accuracy. No credentials were available for live
Aliyun/Volcengine/Deepgram/Soniox A/B; the user explicitly accepted recording
these as pending acceptance on 2026-10-08.
