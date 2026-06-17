// lanRtc.ts — lightweight WebRTC mesh for LanChat (task 03).
//
// All media is peer-to-peer on the LAN, so RTCPeerConnection uses an empty ICE
// server list (host candidates only — no STUN/TURN). Signaling (SDP/ICE) is
// carried over the LanChat control channel via lanchat_send_signal +
// lanchat://signal.
//
// Uses the "perfect negotiation" pattern so initial setup, mesh joins, and
// mid-call track changes (camera↔screen, adding video to an audio call) all
// renegotiate safely without glare. The polite/impolite role is decided by
// comparing node ids.

import { lanchatSendSignal } from "./ipc";

export interface LanRtcCallbacks {
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onPeerClosed: (peerId: string) => void;
  onPeerState?: (peerId: string, state: RTCPeerConnectionState) => void;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  remote: MediaStream;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
}

export class LanRtcSession {
  readonly callId: string;
  private myId: string;
  private peers = new Map<string, PeerEntry>();
  private localStream: MediaStream | null = null;
  private cb: LanRtcCallbacks;

  constructor(callId: string, myId: string, cb: LanRtcCallbacks) {
    this.callId = callId;
    this.myId = myId;
    this.cb = cb;
  }

  setLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    for (const entry of this.peers.values()) this.syncLocalTracks(entry.pc);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  private syncLocalTracks(pc: RTCPeerConnection) {
    if (!this.localStream) return;
    const senders = pc.getSenders();
    for (const track of this.localStream.getTracks()) {
      if (!senders.some((s) => s.track === track)) {
        pc.addTrack(track, this.localStream);
      }
    }
  }

  /** Replace the outgoing video track on every peer (camera ↔ screen). Adds a
   *  track (triggering renegotiation) when no video sender exists yet. */
  async setVideoTrack(track: MediaStreamTrack | null) {
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch {
          /* ignore */
        }
      } else if (track && this.localStream) {
        pc.addTrack(track, this.localStream); // fires negotiationneeded
      }
    }
  }

  /** Create (or get) a connection to `peerId`. Negotiation is automatic. */
  connect(peerId: string): void {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const entry: PeerEntry = {
      pc,
      remote: new MediaStream(),
      makingOffer: false,
      ignoreOffer: false,
      polite: this.myId < peerId,
    };
    this.peers.set(peerId, entry);

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          await lanchatSendSignal(peerId, "signal-sdp", {
            callId: this.callId,
            sdpType: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          });
        }
      } catch {
        /* ignore */
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void lanchatSendSignal(peerId, "signal-ice", { callId: this.callId, candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => entry.remote.addTrack(t));
      if (e.streams.length === 0) entry.remote.addTrack(e.track);
      this.cb.onRemoteStream(peerId, entry.remote);
    };
    pc.onconnectionstatechange = () => {
      this.cb.onPeerState?.(peerId, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.closePeer(peerId);
    };

    this.syncLocalTracks(pc);
  }

  async handleSignal(from: string, type: string, payload: Record<string, unknown>): Promise<void> {
    if (payload.callId && payload.callId !== this.callId) return;
    if (!this.peers.has(from)) this.connect(from);
    const entry = this.peers.get(from);
    if (!entry) return;
    const { pc } = entry;

    if (type === "signal-sdp") {
      const description = { type: payload.sdpType as RTCSdpType, sdp: payload.sdp as string };
      const offerCollision = description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;
      try {
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            await lanchatSendSignal(from, "signal-sdp", {
              callId: this.callId,
              sdpType: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            });
          }
        }
      } catch {
        /* ignore */
      }
    } else if (type === "signal-ice") {
      if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
        } catch {
          if (!entry.ignoreOffer) {
            /* genuine error — ignore late candidates */
          }
        }
      }
    }
  }

  closePeer(peerId: string) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try {
      entry.pc.ontrack = null;
      entry.pc.onicecandidate = null;
      entry.pc.onnegotiationneeded = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch {
      /* ignore */
    }
    this.peers.delete(peerId);
    this.cb.onPeerClosed(peerId);
  }

  peerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  close() {
    for (const id of this.peerIds()) this.closePeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
