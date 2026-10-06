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
