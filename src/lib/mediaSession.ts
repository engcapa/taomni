// mediaSession.ts — the media-transport abstraction for LanChat A/V (task 03 +
// the Linux native-transport plan).
//
// `lanCallStore` talks to one `MediaSession` per call. Two implementations sit
// behind this interface, chosen at runtime by `createMediaSession`:
//
//   • WebRtcSession  (lanRtc.ts) — Windows / macOS, where the webview exposes
//     `RTCPeerConnection`. Media is SRTP over WebRTC; behaviour is unchanged
//     from the original task-03 implementation.
//   • NativeSession  (nativeSession.ts) — Linux / any webview without
//     `RTCPeerConnection` (WebKitGTK does not expose WebRTC). Capture, encode,
//     transport and decode happen in Rust; the webview renders decoded frames
//     to a <canvas> + AudioWorklet over a loopback WebSocket. No `MediaStream`
//     is produced for remotes — see `onRemoteCanvas`.
//
// The two stacks are NOT wire-compatible (WebRTC/SRTP vs native H.264/Opus over
// the mTLS mesh). Per the plan's default (option b), native calls are
// Linux↔Linux only; a mismatched pair is rejected with a clear message (see the
// store's stack-capability check).

import { hasWebRtc } from "./runtime";

/** Callbacks a `MediaSession` raises back to the store/UI. */
export interface MediaSessionCallbacks {
  /** A remote peer's `MediaStream` became available (WebRTC stacks only). */
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  /** A remote peer's decoded video should render into this canvas target
   *  (native stack only). Called once per peer when its first frame arrives. */
  onRemoteCanvas?: (peerId: string, canvas: HTMLCanvasElement) => void;
  /** A remote peer's audio level (0..1), reported periodically by the native
   *  stack for speaker highlighting (WebRTC stacks derive this from the stream
   *  via the Web Audio analyser instead). */
  onRemoteLevel?: (peerId: string, level: number) => void;
  /** A peer left / its connection closed. */
  onPeerClosed: (peerId: string) => void;
  /** Optional connection-state notification (WebRTC stacks only). */
  onPeerState?: (peerId: string, state: RTCPeerConnectionState) => void;
}

/** The transport-agnostic media session contract used by `lanCallStore`. */
export interface MediaSession {
  readonly callId: string;
  /** Whether this is the native (Rust direct-render) stack. The store/UI use
   *  this to switch between `<video srcObject>` and `<canvas>` rendering. */
  readonly isNative: boolean;
  /** Provide the local capture stream (WebRTC); native ignores it and drives
   *  capture in Rust. */
  setLocalStream(stream: MediaStream | null): void;
  /** Mute/unmute the local microphone. WebRTC toggles the audio track; native
   *  drives the Rust Opus encoder over IPC. */
  setMic(on: boolean): void;
  /** Swap the outgoing video track (camera ↔ screen); native ignores it. */
  setVideoTrack(track: MediaStreamTrack | null): Promise<void>;
  /** Start (or fetch) a connection to a peer; negotiation is automatic. */
  connect(peerId: string): void;
  /** Consume an inbound signaling frame for this call. */
  handleSignal(from: string, type: string, payload: Record<string, unknown>): Promise<void>;
  /** Tear down a single peer. */
  closePeer(peerId: string): void;
  /** Tear down the whole session and release local resources. */
  close(): void;
}

/** Identifier for the media stack a node speaks, exchanged in call signaling so
 *  a mismatched pair (e.g. Linux-native ↔ macOS-WebRTC) can fail with a clear
 *  message instead of a silent dead call. */
export type MediaStackKind = "webrtc" | "native";

/** The media stack this node uses for new calls. */
export function localMediaStack(): MediaStackKind {
  return hasWebRtc() ? "webrtc" : "native";
}

/** Build the right `MediaSession` for this runtime. WebRTC where the webview
 *  exposes `RTCPeerConnection`, otherwise the Rust-native stack. The dynamic
 *  imports keep each implementation (and its heavy deps) out of the other
 *  stack's bundle and avoid an import cycle through this module. */
export async function createMediaSession(
  callId: string,
  myId: string,
  cb: MediaSessionCallbacks,
): Promise<MediaSession> {
  if (hasWebRtc()) {
    const { WebRtcSession } = await import("./lanRtc");
    return new WebRtcSession(callId, myId, cb);
  }
  const { NativeSession } = await import("./nativeSession");
  return new NativeSession(callId, myId, cb);
}
