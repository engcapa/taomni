// nativeSession.ts — the Rust-native media stack for LanChat A/V on webviews
// without WebRTC (Linux / WebKitGTK).
//
// Unlike WebRtcSession, this does NOT create RTCPeerConnections or produce
// MediaStreams. Instead it drives Rust over IPC:
//
//   • capture/encode/transport/decode happen in the backend (cpal + Opus for
//     audio, X11 capture / nokhwa + H.264 for video — wired across the
//     native-AV phases) over the existing mTLS mesh (TAG_MEDIA frames);
//   • the backend exposes one loopback WebSocket per call; this class connects
//     to it and routes decoded frames — video to a per-peer <canvas>, audio to
//     an AudioWorklet — and reports peer presence / audio levels to the store.
//
// Media negotiation rides the same `lanchat://signal` relay as WebRTC, but with
// `nmedia-offer` / `nmedia-answer` / `nmedia-stop` frames. Per the plan's
// option (b) the native stack only interoperates Linux↔Linux.

import {
  lanchatSendSignal,
  nmediaAddPeer,
  nmediaPeerState,
  nmediaRemovePeer,
  nmediaStart,
  nmediaStop,
} from "./ipc";
import type { MediaSession, MediaSessionCallbacks } from "./mediaSession";

export class NativeSession implements MediaSession {
  readonly callId: string;
  readonly isNative = true;
  private myId: string;
  private cb: MediaSessionCallbacks;
  private peers = new Set<string>();
  private canvases = new Map<string, HTMLCanvasElement>();
  private ws: WebSocket | null = null;
  private startPromise: Promise<void>;
  private closed = false;
  /** Our intended local capture state, sent in offers/answers. */
  private localState = { mic: true, cam: false, screen: false };

  constructor(callId: string, myId: string, cb: MediaSessionCallbacks) {
    this.callId = callId;
    this.myId = myId;
    this.cb = cb;
    this.startPromise = this.start();
  }

  // PLACEHOLDER_METHODS

  /** Set the local mic/cam/screen intent advertised to peers in offers. */
  setLocalState(mic: boolean, cam: boolean, screen: boolean): void {
    this.localState = { mic, cam, screen };
  }

  private async start(): Promise<void> {
    try {
      const port = await nmediaStart(this.callId);
      if (this.closed) {
        await nmediaStop(this.callId).catch(() => undefined);
        return;
      }
      this.openWs(port);
    } catch (e) {
      console.error("native media start failed:", e);
    }
  }

  private openWs(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onerror = () => undefined;
    this.ws = ws;
    // Keepalive so the relay's idle watchdog doesn't tear us down.
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      else clearInterval(ping);
    }, 10_000);
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          break;
        case "peer-add":
          this.onPeerAdd(msg.peerId as string);
          break;
        case "peer-remove":
          this.cb.onPeerClosed(msg.peerId as string);
          break;
        case "level":
          this.cb.onRemoteLevel?.(msg.peerId as string, msg.level as number);
          break;
        default:
          break;
      }
      return;
    }
    // Binary media frame: [kind][peerIdLen][peerId][payload]. Decoded-media
    // rendering (audio → AudioWorklet, video → canvas) lands in Phase 2+.
  }

  private onPeerAdd(peerId: string): void {
    let canvas = this.canvases.get(peerId);
    if (!canvas) {
      canvas = document.createElement("canvas");
      this.canvases.set(peerId, canvas);
    }
    this.cb.onRemoteCanvas?.(peerId, canvas);
  }

  setLocalStream(_stream: MediaStream | null): void {
    /* native capture is driven in Rust; nothing to wire here */
  }

  async setVideoTrack(_track: MediaStreamTrack | null): Promise<void> {
    /* camera/screen switching is a Rust IPC call, not a track swap */
  }

  connect(peerId: string): void {
    if (peerId === this.myId || this.peers.has(peerId)) return;
    this.peers.add(peerId);
    void this.startPromise.then(async () => {
      if (this.closed) return;
      await nmediaAddPeer(this.callId, peerId).catch(() => undefined);
      this.onPeerAdd(peerId); // register presence immediately (tile before media)
      await lanchatSendSignal(peerId, "nmedia-offer", {
        callId: this.callId,
        ...this.localState,
      }).catch(() => undefined);
    });
  }

  async handleSignal(
    from: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (payload.callId && payload.callId !== this.callId) return;
    switch (type) {
      case "nmedia-offer": {
        this.peers.add(from);
        await this.startPromise;
        if (this.closed) return;
        await nmediaAddPeer(this.callId, from).catch(() => undefined);
        this.onPeerAdd(from);
        await lanchatSendSignal(from, "nmedia-answer", {
          callId: this.callId,
          ...this.localState,
        }).catch(() => undefined);
        break;
      }
      case "nmedia-answer": {
        this.peers.add(from);
        await this.startPromise;
        if (this.closed) return;
        await nmediaAddPeer(this.callId, from).catch(() => undefined);
        this.onPeerAdd(from);
        break;
      }
      case "nmedia-stop":
        this.closePeer(from);
        break;
      case "media-state":
        await nmediaPeerState(
          this.callId,
          from,
          !!payload.mic,
          !!payload.cam,
          !!payload.screen,
        ).catch(() => undefined);
        break;
      default:
        break;
    }
  }

  closePeer(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    this.canvases.delete(peerId);
    void nmediaRemovePeer(this.callId, peerId).catch(() => undefined);
    this.cb.onPeerClosed(peerId);
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.peers]) {
      void lanchatSendSignal(id, "nmedia-stop", { callId: this.callId }).catch(() => undefined);
      this.peers.delete(id);
    }
    this.canvases.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    void nmediaStop(this.callId).catch(() => undefined);
  }
}
