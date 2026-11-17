# Native binary side channel

This private workspace library implements the existing API v1 `BinaryRef` for
bounded payloads such as a captured still frame. It is independent of Tauri,
WebViews, UI lifetime, application proxies and any particular plugin business.
It is a TASK-002 foundation, not a continuous RDP stream or G5 throughput result.

`offer` owns an exact `127.0.0.1` listener, one random 256-bit bearer and a
separate unpredictable path. The bearer travels only in the authenticated
stdio RPC response and the native client's Authorization header. It is never a
URL/query parameter. Host/path/header mismatches and all Origin headers are
rejected without consuming the offer. A stalled unauthenticated handshake has
a 250 ms budget; an authenticated peer consumes the offer and closes its
listener before receiving bytes. Token comparison uses constant-time equality.

The sender awaits every 64 KiB binary message, with bounded WebSocket buffers.
Both ends impose an overall deadline and a maximum payload of 64 MiB. The
receiver connects directly to the numeric loopback endpoint and publishes no
bytes until normal completion, exact length and SHA-256 agree. It rejects text,
oversized wire messages, truncated frames and abrupt closes. This version uses
plain `ws` on loopback; a `wss` descriptor is explicitly rejected by the client
without downgrading it.

The RPC/service operation must own `BinaryOffer`, cap its live offers, and call
`cancel_and_wait` when cancelled, revoked or disconnected. Closing a view must
not own this handle. `Drop` is an abort fallback; the explicit method awaits
listener/socket/payload reclamation. This library does not grant capture or
file permissions and has not yet been wired into production capture services.

Service workers share one core-owned `TransferPool`. Its default budget is eight
live/reserved transfers and 128 MiB of payload capacity, in addition to each
transfer's 64 MiB limit. Reserve before capturing/allocating. Buffer capacity,
including unused Vec capacity, must fit the reservation; saturation returns
`BINARY_TRANSFER_BUSY` without queueing more payloads. A zero-byte transfer still
uses a listener slot. Pool clones share the budget; separate pools do not.

`offer_with_owner` moves the reservation and caller's lease into the real network
task. Both the preparing future and the unpolled task retain complete resource
owners whose buffers/listeners are destroyed before their leases. `TransferScope`
provides the parent's cancellation token and absolute deadline; preparing and
hashing cannot renew that deadline. Explicit offer cancellation affects its
child token, preserving the outer operation and sibling transfers.

`taomni-plugin-services::offer_binary_for_request` binds this transport to an
existing reverse request. Retirement, cancellation, host disconnect/termination,
Vault revocation and profile replacement notify the child without polling. The
actual network task retains the same admission/OS lease until cleanup; an ack
alone cannot let revocation drain past a live transfer. The caller must still
check signed service permissions before capturing and retain the returned offer.
This adapter is not yet exposed as a production `capture.still` service.

Local verification runs only the pure library tests and compiles the ignored
integration harness. GitHub's registered upgrade `protocol_only=true` entry
runs all ten original socket/process scenarios, a kernel resource-order scenario
and seven request/OS-lease scenarios on Linux, Windows and macOS. The
child receives its descriptor through a private stdin pipe, verifies empty,
multichunk and full-HD payloads and reports only length/hash. The remaining
scenarios cover failed authorization, stalled handshake, replay refusal,
deadline/cancellation and malicious payloads. Source identity, selected names
and raw logs are always retained in `modular-protocol-*` artifacts. The lease
scenarios exercise real admission, sockets and OS locks with an in-process
authenticated identity/ack fixture; the separate real-host gate verifies the
transport's actual process authentication and revoke lifecycle.

Future closure: connect live operation/admission ownership to capture services,
add continuous stream flow control and compare the actual RDP path with its
matched `rdp-probe` baseline and raw samples before declaring G5 passed.
