import { create } from "zustand";

import { lanchatSendSignal, listenLanChatSignal } from "../lib/ipc";
import { LanRtcSession } from "../lib/lanRtc";
import { isTauriRuntime } from "../lib/runtime";
import type { LanCallKind, LanSignal } from "../types";
import { useLanChatStore } from "./lanChatStore";

export type CallStatus = "calling" | "ringing" | "active" | "ended";

interface IncomingCall {
  callId: string;
  from: string;
  fromName: string;
  kind: LanCallKind;
}

interface RemotePeer {
  stream: MediaStream | null;
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

interface CallStore {
  /** Active call, or null. */
  callId: string | null;
  kind: LanCallKind;
  /** "direct" peer for 1:1, or a group id for a meeting. */
  groupId: string | null;
  status: CallStatus;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  localStream: MediaStream | null;
  /** Local screen-share preview stream (when screenOn). */
  screenStream: MediaStream | null;
  remotes: Record<string, RemotePeer>;
  incoming: IncomingCall | null;

  init: () => Promise<void>;
  startCall: (peerId: string, kind: LanCallKind) => Promise<void>;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => void;
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleScreen: () => Promise<void>;
}

let session: LanRtcSession | null = null;
let signalUnsub: (() => void) | null = null;

function myNodeId(): string {
  return useLanChatStore.getState().profile?.id ?? "";
}

function peerName(id: string): string {
  const roster = useLanChatStore.getState().roster;
  return roster.find((p) => p.id === id)?.name ?? id.slice(0, 6);
}

async function getMedia(kind: LanCallKind): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: kind === "video" ? { width: 1280, height: 720 } : false,
  });
}

function broadcastMediaState() {
  const s = useLanCallStore.getState();
  if (!s.callId) return;
  const payload = { callId: s.callId, mic: s.micOn, cam: s.camOn, screen: s.screenOn };
  for (const peerId of Object.keys(s.remotes)) {
    void lanchatSendSignal(peerId, "media-state", payload);
  }
}

export const useLanCallStore = create<CallStore>((set, get) => ({
  callId: null,
  kind: "audio",
  groupId: null,
  status: "ended",
  micOn: true,
  camOn: true,
  screenOn: false,
  localStream: null,
  screenStream: null,
  remotes: {},
  incoming: null,

  init: async () => {
    if (signalUnsub || !isTauriRuntime()) return;
    try {
      signalUnsub = await listenLanChatSignal((sig) => void handleSignal(sig));
    } catch (e) {
      console.debug("lanCall init:", e);
    }
  },

  startCall: async (peerId, kind) => {
    if (get().callId) return;
    const callId = crypto.randomUUID();
    let local: MediaStream;
    try {
      local = await getMedia(kind);
    } catch {
      return; // permission denied / no device
    }
    session = new LanRtcSession(callId, myNodeId(), rtcCallbacks());
    session.setLocalStream(local);
    set({
      callId,
      kind,
      groupId: null,
      status: "calling",
      micOn: true,
      camOn: kind === "video",
      screenOn: false,
      localStream: local,
      remotes: { [peerId]: { stream: null, mic: true, cam: kind === "video", screen: false } },
    });
    await lanchatSendSignal(peerId, "call-invite", { callId, kind });
  },

  acceptIncoming: async () => {
    const inc = get().incoming;
    if (!inc) return;
    let local: MediaStream;
    try {
      local = await getMedia(inc.kind);
    } catch {
      get().rejectIncoming();
      return;
    }
    session = new LanRtcSession(inc.callId, myNodeId(), rtcCallbacks());
    session.setLocalStream(local);
    set({
      callId: inc.callId,
      kind: inc.kind,
      groupId: null,
      status: "active",
      micOn: true,
      camOn: inc.kind === "video",
      screenOn: false,
      localStream: local,
      remotes: { [inc.from]: { stream: null, mic: true, cam: inc.kind === "video", screen: false } },
      incoming: null,
    });
    await lanchatSendSignal(inc.from, "call-accept", { callId: inc.callId });
    // Callee waits for the caller's offer (lanRtc auto-answers).
  },

  rejectIncoming: () => {
    const inc = get().incoming;
    if (inc) void lanchatSendSignal(inc.from, "call-reject", { callId: inc.callId });
    set({ incoming: null });
  },

  hangup: () => {
    const s = get();
    if (s.callId) {
      for (const peerId of Object.keys(s.remotes)) {
        void lanchatSendSignal(peerId, "call-end", { callId: s.callId });
      }
    }
    session?.close();
    session = null;
    const s2 = get();
    s2.screenStream?.getTracks().forEach((t) => t.stop());
    set({ callId: null, status: "ended", localStream: null, screenStream: null, screenOn: false, remotes: {}, groupId: null });
  },

  toggleMic: () => {
    const s = get();
    const next = !s.micOn;
    s.localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
    set({ micOn: next });
    broadcastMediaState();
  },

  toggleCam: () => {
    const s = get();
    const next = !s.camOn;
    s.localStream?.getVideoTracks().forEach((t) => (t.enabled = next));
    set({ camOn: next });
    broadcastMediaState();
  },

  // NOTE: getDisplayMedia works on Windows (WebView2) and Linux (WebKitGTK w/
  // PipeWire portal). macOS WKWebView support is limited; the documented
  // fallback is an xcap-captured frame stream via canvas.captureStream — left
  // as a follow-up since it can't be exercised in this environment.
  toggleScreen: async () => {
    const s = get();
    if (!s.callId || !session) return;
    if (!s.screenOn) {
      let display: MediaStream;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch {
        return;
      }
      const track = display.getVideoTracks()[0];
      if (!track) return;
      await session.setVideoTrack(track);
      track.onended = () => {
        void get().toggleScreen();
      };
      set({ screenOn: true, screenStream: display });
      broadcastMediaState();
    } else {
      s.screenStream?.getTracks().forEach((t) => t.stop());
      const camTrack = s.localStream?.getVideoTracks()[0] ?? null;
      await session.setVideoTrack(camTrack);
      set({ screenOn: false, screenStream: null });
      broadcastMediaState();
    }
  },
}));

function rtcCallbacks() {
  return {
    onRemoteStream: (peerId: string, stream: MediaStream) => {
      useLanCallStore.setState((s) => ({
        remotes: { ...s.remotes, [peerId]: { ...(s.remotes[peerId] ?? { mic: true, cam: true, screen: false }), stream } },
      }));
    },
    onPeerClosed: (peerId: string) => {
      useLanCallStore.setState((s) => {
        const remotes = { ...s.remotes };
        delete remotes[peerId];
        // 1:1: peer gone => end the call.
        if (!s.groupId && Object.keys(remotes).length === 0 && s.callId) {
          session?.close();
          session = null;
          s.screenStream?.getTracks().forEach((t) => t.stop());
          return { remotes, callId: null, status: "ended" as CallStatus, localStream: null, screenStream: null, screenOn: false };
        }
        return { remotes };
      });
    },
  };
}

async function handleSignal(sig: LanSignal) {
  const { from, type, payload } = sig;
  const store = useLanCallStore.getState();
  switch (type) {
    case "call-invite": {
      // Ignore if already in a call (busy).
      if (store.callId) {
        void lanchatSendSignal(from, "call-reject", { callId: payload.callId as string, busy: true });
        return;
      }
      useLanCallStore.setState({
        incoming: {
          callId: payload.callId as string,
          from,
          fromName: peerName(from),
          kind: (payload.kind as LanCallKind) ?? "audio",
        },
      });
      break;
    }
    case "call-accept": {
      // Caller side: peer accepted — start offering.
      if (store.callId === payload.callId) {
        useLanCallStore.setState({ status: "active" });
        session?.connect(from);
      }
      break;
    }
    case "call-reject":
    case "call-cancel":
    case "call-end": {
      if (store.incoming?.callId === payload.callId) {
        useLanCallStore.setState({ incoming: null });
      }
      if (store.callId === payload.callId) {
        session?.close();
        session = null;
        store.screenStream?.getTracks().forEach((t) => t.stop());
        useLanCallStore.setState({ callId: null, status: "ended", localStream: null, screenStream: null, screenOn: false, remotes: {} });
      }
      break;
    }
    case "media-state": {
      useLanCallStore.setState((s) => {
        const prev = s.remotes[from];
        if (!prev) return {};
        return {
          remotes: {
            ...s.remotes,
            [from]: { ...prev, mic: !!payload.mic, cam: !!payload.cam, screen: !!payload.screen },
          },
        };
      });
      break;
    }
    case "signal-sdp":
    case "signal-ice": {
      await session?.handleSignal(from, type, payload);
      break;
    }
    default:
      break;
  }
}
