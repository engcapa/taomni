// lanRtc.ts — lightweight WebRTC mesh for LanChat (task 03).
//
// All media is peer-to-peer on the LAN, so RTCPeerConnection is configured with
// an empty ICE server list (host candidates only — no STUN/TURN). Signaling
// (SDP/ICE) is carried over the LanChat control channel via the
// lanchat_send_signal command + the lanchat://signal event.
//
// Glare avoidance: for any pair, exactly one side creates the offer — the
// caller (1:1) or the newly-joined member (mesh). The other side only answers.

import { lanchatSendSignal } from "./ipc";

export interface LanRtcCallbacks {
  /** A remote peer's media stream became available. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  /** A peer connection closed/failed. */
  onPeerClosed: (peerId: string) => void;
  /** Connection-state change for a peer (for UI). */
  onPeerState?: (peerId: string, state: RTCPeerConnectionState) => void;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  remote: MediaStream;
}

/** Manages the set of peer connections for a single call/meeting. */
export class LanRtcSession {
  readonly callId: string;
  private peers = new Map<string, PeerEntry>();
  private localStream: MediaStream | null = null;
  private cb: LanRtcCallbacks;

  constructor(callId: string, cb: LanRtcCallbacks) {
    this.callId = callId;
    this.cb = cb;
  }

  /** Replace the local media stream and (re)attach its tracks to all peers. */
  setLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    for (const { pc } of this.peers.values()) {
      this.syncLocalTracks(pc);
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  private syncLocalTracks(pc: RTCPeerConnection) {
    const senders = pc.getSenders();
    const tracks = this.localStream ? this.localStream.getTracks() : [];
    // Add tracks not yet present.
    for (const track of tracks) {
      if (!senders.some((s) => s.track === track)) {
        pc.addTrack(track, this.localStream!);
      }
    }
  }

  /** Begin (or accept) a connection to `peerId`. `offer=true` for the side that
   *  initiates (caller / new joiner); the other side passes false. */
  async connect(peerId: string, offer: boolean): Promise<void> {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const remote = new MediaStream();
    this.peers.set(peerId, { pc, remote });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void lanchatSendSignal(peerId, "signal-ice", {
          callId: this.callId,
          candidate: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t));
      if (e.streams.length === 0) remote.addTrack(e.track);
      this.cb.onRemoteStream(peerId, remote);
    };
    pc.onconnectionstatechange = () => {
      this.cb.onPeerState?.(peerId, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.closePeer(peerId);
      }
    };

    this.syncLocalTracks(pc);

    if (offer) {
      const desc = await pc.createOffer();
      await pc.setLocalDescription(desc);
      await lanchatSendSignal(peerId, "signal-sdp", {
        callId: this.callId,
        sdpType: desc.type,
        sdp: desc.sdp,
      });
    }
  }

  /** Feed an inbound signaling frame into the right peer connection. */
  async handleSignal(from: string, type: string, payload: Record<string, unknown>): Promise<void> {
    if (payload.callId && payload.callId !== this.callId) return;
    if (type === "signal-sdp") {
      // Answerer may not have a peer entry yet.
      if (!this.peers.has(from)) await this.connect(from, false);
      const entry = this.peers.get(from);
      if (!entry) return;
      const sdpType = payload.sdpType as RTCSdpType;
      await entry.pc.setRemoteDescription({ type: sdpType, sdp: payload.sdp as string });
      if (sdpType === "offer") {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        await lanchatSendSignal(from, "signal-sdp", {
          callId: this.callId,
          sdpType: answer.type,
          sdp: answer.sdp,
        });
      }
    } else if (type === "signal-ice") {
      const entry = this.peers.get(from);
      if (entry && payload.candidate) {
        try {
          await entry.pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
        } catch {
          /* ignore late/duplicate candidates */
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

  /** Tear down all connections and stop local media. */
  close() {
    for (const id of this.peerIds()) this.closePeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
