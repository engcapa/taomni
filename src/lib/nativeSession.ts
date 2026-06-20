// nativeSession.ts — the Rust-native media stack for LanChat A/V on webviews
// without WebRTC (Linux / WebKitGTK).
//
// Unlike WebRtcSession, this does NOT create RTCPeerConnections or produce
// MediaStreams. Instead it drives Rust over IPC:
//
//   • capture/encode/transport/decode all happen in the backend (cpal + Opus
//     for audio, X11 capture / nokhwa + H.264 for video) over the existing
//     mTLS mesh (TAG_MEDIA frames);
//   • the backend exposes one loopback WebSocket per call; this class connects
//     to it and routes decoded frames — video to a per-peer <canvas>, audio to
//     an AudioWorklet — and forwards mic/cam/screen toggles back as IPC calls.
//
// Media negotiation rides the same `lanchat://signal` relay as WebRTC, but with
// `nmedia-offer` / `nmedia-answer` / `nmedia-stop` frames (see handleSignal).
//
// Scope: the transport/relay plumbing and codecs are built across the native-AV
// phases. This module is the frontend half; methods are filled in as each phase
// lands. Audio (Phase 2) comes first, then screen (Phase 3) and camera (Phase 4).

import type { MediaSession, MediaSessionCallbacks } from "./mediaSession";

export class NativeSession implements MediaSession {
  readonly callId: string;
  readonly isNative = true;
  private myId: string;
  private cb: MediaSessionCallbacks;
  private peers = new Set<string>();
  /** Loopback WS to the backend media relay for this call (Phase 1c+). */
  private ws: WebSocket | null = null;

  constructor(callId: string, myId: string, cb: MediaSessionCallbacks) {
    this.callId = callId;
    this.myId = myId;
    this.cb = cb;
  }

  // The local capture stream is owned by Rust on the native stack; the store
  // still passes one (for the local self-preview mic level), but transport does
  // not use it. Kept as a no-op to satisfy the interface.
  setLocalStream(_stream: MediaStream | null): void {
    /* native capture is driven in Rust; nothing to wire here */
  }

  async setVideoTrack(_track: MediaStreamTrack | null): Promise<void> {
    /* camera/screen switching is a Rust IPC call (toggleScreen/toggleCam),
       not a track swap; nothing to do here */
  }

  connect(peerId: string): void {
    if (peerId === this.myId) return;
    this.peers.add(peerId);
    // Per-peer media-stream setup is issued in Phase 1c+ (nmedia-offer +
    // loopback WS). The scaffold tracks membership so signaling routes cleanly.
  }

  async handleSignal(
    from: string,
    type: string,
    _payload: Record<string, unknown>,
  ): Promise<void> {
    // nmedia-* frames drive per-peer stream setup/teardown on the native stack.
    // Wired in Phase 1c+; for now just keep peer membership coherent.
    if (type === "nmedia-stop") {
      this.closePeer(from);
    }
  }

  closePeer(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    this.cb.onPeerClosed(peerId);
  }

  close(): void {
    for (const id of [...this.peers]) this.closePeer(id);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
