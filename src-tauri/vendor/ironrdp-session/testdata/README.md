# xrdp resize regression

`xrdp-resize.bin` retains the server graphics and activation Share Data packets
from hosted run [37396820515](https://github.com/engcapa/taomni/actions/runs/37396820515)
at `b020cffe1d949cd5a067188ea8a408685127ad62`, testcase
`TC-RDPC-REF-02-xrdp`. The disposable reference desktop starts at 994×750;
clicking its known target turns the center white, then fullscreen resizes it to
1492×1030. The capture contains server active-session packets only.

Each record is a one-byte kind, a four-byte little-endian payload length, and
that payload. Kinds are 0 (Fast-Path), 1 (active X224), 2 (activation X224), and
3 (resized framebuffer: two little-endian u16 dimensions). Static-channel
traffic, Demand Active, and the unrelated first connection are omitted.

The Font Map's compression flags are `0xe1`: COMPRESSED, AT_FRONT, FLUSHED,
and MPPC 64K. Its payload consists of literal bytes, so typed Font Map parsing
succeeds even when the shared decompressor misses its history reset. The next
surface is then misdecoded with codec ID zero instead of RemoteFX ID three,
leaving the resized center pixel transparent. Normalizing activation packets
through the connection's existing decompressor preserves opaque white,
magenta, and cyan reference pixels after the resize.

FreeRDP 3.32.0 and the vendored IronRDP bulk decoder independently produce
identical output for all 33 updates in the original full capture. Omitting
activation updates reproduces five later mismatches, including the damaged
surface header. The focused Rust test replays the retained packets through
the product's active-stage decoder and verifies the actual framebuffer.

`xrdp-repeated-resize.bin` retains the IO-channel and Fast-Path packets from
connection 1 of run [38006071650](https://github.com/engcapa/taomni/actions/runs/38006071650)
at `0f437abbb6f36550e01dc2f4678e9653582f226a`,
`linux-ubuntu-22.04-vnc-native`, `TC-RDPC-REF-02-xrdp`.
The original `rdp-server-packets.log` records three resize sequences. Static
channel traffic and the first connection are omitted; the active-session
capture contains no logon credentials. Record kinds 0–3 use the format above;
kind 4 marks Fast-Path packets received during activation.

The third Synchronize PDU references the MPPC history of compressed pointer
updates sent between Demand Active and Synchronize. Discarding those packets
reproduces the original invalid Synchronize message type every time. Consuming
their compression updates preserves all three typed activation PDUs and the
two completed resize repaints without painting the deactivated surface.
