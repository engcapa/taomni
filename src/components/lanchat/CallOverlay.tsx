import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, MonitorUp, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

import { useLanCallStore } from "../../stores/lanCallStore";
import { avatarGradient, avatarInitial } from "./util";

/** Returns true while the stream's audio is above a speaking threshold. */
function useSpeaking(stream: MediaStream | null): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    let raf = 0;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setSpeaking(avg > 18);
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      return;
    }
    return () => {
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => undefined);
    };
  }, [stream]);
  return speaking;
}

function VideoTile({
  stream,
  muted,
  label,
  camOff,
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
  camOff: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const speaking = useSpeaking(stream);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div
      className="relative grid place-items-center overflow-hidden rounded-xl"
      style={{
        background: "#111827",
        border: `2px solid ${speaking ? "#22c55e" : "transparent"}`,
        boxShadow: speaking ? "0 0 0 3px rgba(34,197,94,.25)" : "none",
        minHeight: 160,
      }}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: camOff ? "none" : "block" }}
      />
      {camOff ? (
        <div
          className="grid h-[74px] w-[74px] place-items-center rounded-full text-[26px] text-white"
          style={{ background: avatarGradient(label) }}
        >
          {avatarInitial(label)}
        </div>
      ) : null}
      <div
        className="absolute bottom-2 left-2 rounded-md px-2 py-0.5 text-[11px] text-white"
        style={{ background: "rgba(0,0,0,.5)" }}
      >
        {label}
      </div>
    </div>
  );
}

/** Overlay rendering the incoming-call prompt and the active call window.
 *  Mounted once at the app root so a call survives tab switches. */
export function CallOverlay() {
  const init = useLanCallStore((s) => s.init);
  const incoming = useLanCallStore((s) => s.incoming);
  const callId = useLanCallStore((s) => s.callId);
  const kind = useLanCallStore((s) => s.kind);
  const status = useLanCallStore((s) => s.status);
  const micOn = useLanCallStore((s) => s.micOn);
  const camOn = useLanCallStore((s) => s.camOn);
  const screenOn = useLanCallStore((s) => s.screenOn);
  const localStream = useLanCallStore((s) => s.localStream);
  const screenStream = useLanCallStore((s) => s.screenStream);
  const remotes = useLanCallStore((s) => s.remotes);
  const acceptIncoming = useLanCallStore((s) => s.acceptIncoming);
  const rejectIncoming = useLanCallStore((s) => s.rejectIncoming);
  const hangup = useLanCallStore((s) => s.hangup);
  const toggleMic = useLanCallStore((s) => s.toggleMic);
  const toggleCam = useLanCallStore((s) => s.toggleCam);
  const toggleScreen = useLanCallStore((s) => s.toggleScreen);

  useEffect(() => {
    void init();
  }, [init]);

  // Release camera/mic if the window/app is closed mid-call (avoid a device
  // indicator staying lit). Best-effort track stop on unload.
  useEffect(() => {
    const release = () => {
      const s = useLanCallStore.getState();
      s.localStream?.getTracks().forEach((t) => t.stop());
      s.screenStream?.getTracks().forEach((t) => t.stop());
    };
    window.addEventListener("beforeunload", release);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("beforeunload", release);
      window.removeEventListener("pagehide", release);
    };
  }, []);

  return (
    <>
      {incoming ? (
        <div
          className="fixed right-4 top-4 z-[200] w-72 rounded-xl p-3"
          style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <div className="mb-2 text-[13px]">
            <span className="font-semibold">{incoming.fromName}</span>{" "}
            {incoming.groupId ? "发起了群会议" : `邀请你${incoming.kind === "video" ? "视频" : "语音"}通话`}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void acceptIncoming()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-semibold text-white"
              style={{ background: "var(--ok,#16a34a)" }}
            >
              <Phone className="h-4 w-4" /> 接听
            </button>
            <button
              type="button"
              onClick={rejectIncoming}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-semibold text-white"
              style={{ background: "#c42b1c" }}
            >
              <PhoneOff className="h-4 w-4" /> 拒接
            </button>
          </div>
        </div>
      ) : null}

      {callId ? (
        <div
          className="fixed left-1/2 top-1/2 z-[190] flex w-[680px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl"
          style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <div
            className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold"
            style={{ background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))", borderBottom: "1px solid var(--taomni-chrome-border)" }}
          >
            内网{kind === "video" ? "视频" : "语音"}通话
            <span className="font-normal" style={{ color: "var(--taomni-text-muted)" }}>
              · {status === "calling" ? "呼叫中…" : status === "active" ? "进行中" : status}
            </span>
            <span className="ml-auto text-[11px] font-normal" style={{ color: "var(--taomni-text-muted)" }}>
              {Object.keys(remotes).length >= 8 ? "人数较多，mesh 建议 ≤ 8 人 · " : ""}P2P · 无 STUN/TURN
            </span>
          </div>
          <div
            className="grid flex-1 gap-2 p-3"
            style={{ gridTemplateColumns: `repeat(${Math.min(3, 1 + Object.keys(remotes).length)},1fr)`, background: "#070b14" }}
          >
            <VideoTile stream={screenOn ? screenStream : localStream} muted label={screenOn ? "我（共享屏幕）" : "我"} camOff={!screenOn && (!camOn || kind === "audio")} />
            {Object.entries(remotes).map(([peerId, r]) => (
              <VideoTile key={peerId} stream={r.stream} muted={false} label={peerId.slice(0, 6)} camOff={!r.cam} />
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 py-3" style={{ borderTop: "1px solid var(--taomni-divider)" }}>
            <CtlButton on={micOn} onClick={toggleMic} onIcon={<Mic className="h-5 w-5" />} offIcon={<MicOff className="h-5 w-5" />} />
            {kind === "video" ? (
              <CtlButton on={camOn} onClick={toggleCam} onIcon={<Video className="h-5 w-5" />} offIcon={<VideoOff className="h-5 w-5" />} />
            ) : null}
            <button
              type="button"
              onClick={() => void toggleScreen()}
              title={screenOn ? "停止共享" : "共享屏幕"}
              className="grid h-12 w-12 place-items-center rounded-full"
              style={{
                background: screenOn ? "var(--taomni-accent)" : "var(--taomni-card-bg)",
                color: screenOn ? "#fff" : "var(--taomni-text)",
                border: "1px solid var(--taomni-card-border)",
              }}
            >
              <MonitorUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={hangup}
              className="grid h-12 w-16 place-items-center rounded-3xl text-white"
              style={{ background: "#c42b1c" }}
              title="挂断"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CtlButton({
  on,
  onClick,
  onIcon,
  offIcon,
}: {
  on: boolean;
  onClick: () => void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-12 w-12 place-items-center rounded-full"
      style={{
        background: on ? "var(--taomni-card-bg)" : "#374151",
        color: on ? "var(--taomni-text)" : "#9ca3af",
        border: "1px solid var(--taomni-card-border)",
      }}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}
