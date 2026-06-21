import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Mic, MicOff, Minus, MonitorUp, Phone, PhoneOff, Video, VideoOff, X } from "lucide-react";

import { useLanCallStore } from "../../stores/lanCallStore";
import { useLanChatStore } from "../../stores/lanChatStore";
import { hasWebRtc } from "../../lib/runtime";
import { avatarGradient, avatarInitial } from "./util";

/** This node uses the Rust-native media stack when the webview lacks WebRTC. */
const isNativeStack = !hasWebRtc();

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
  canvas,
  level,
  muted,
  label,
  camOff,
}: {
  stream: MediaStream | null;
  canvas?: HTMLCanvasElement | null;
  level?: number;
  muted: boolean;
  label: string;
  camOff: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const canvasHolder = useRef<HTMLDivElement | null>(null);
  const streamSpeaking = useSpeaking(stream);
  // Native peers have no MediaStream to analyse; use the Rust-reported level.
  const speaking = canvas ? (level ?? 0) > 0.04 : streamSpeaking;
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  // Native stack: mount the per-peer render canvas (Rust decodes into it).
  useEffect(() => {
    const holder = canvasHolder.current;
    if (!holder || !canvas) return;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.objectFit = "contain";
    holder.appendChild(canvas);
    return () => {
      if (canvas.parentNode === holder) holder.removeChild(canvas);
    };
  }, [canvas]);
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
      {canvas ? (
        <div
          ref={canvasHolder}
          style={{ width: "100%", height: "100%", display: camOff ? "none" : "block" }}
        />
      ) : (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: camOff ? "none" : "block" }}
        />
      )}
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
  const levels = useLanCallStore((s) => s.levels);
  const roster = useLanChatStore((s) => s.roster);
  const acceptIncoming = useLanCallStore((s) => s.acceptIncoming);
  const rejectIncoming = useLanCallStore((s) => s.rejectIncoming);
  const hangup = useLanCallStore((s) => s.hangup);
  const toggleMic = useLanCallStore((s) => s.toggleMic);
  const toggleCam = useLanCallStore((s) => s.toggleCam);
  const toggleScreen = useLanCallStore((s) => s.toggleScreen);
  const callError = useLanCallStore((s) => s.callError);
  const clearCallError = useLanCallStore((s) => s.clearCallError);

  useEffect(() => {
    void init();
  }, [init]);

  // Auto-dismiss a surfaced media/permission error after a few seconds.
  useEffect(() => {
    if (!callError) return;
    const t = setTimeout(() => clearCallError(), 6000);
    return () => clearTimeout(t);
  }, [callError, clearCallError]);

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

  // Draggable + minimizable call window. `pos` is an offset from the centered
  // position; the title bar (or the pill's grip) drags it. A new call resets to
  // centered + expanded.
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{ px: number; py: number; bx: number; by: number } | null>(null);
  useEffect(() => {
    if (!callId) {
      setMinimized(false);
      setPos({ dx: 0, dy: 0 });
    }
  }, [callId]);
  const onDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { px: e.clientX, py: e.clientY, bx: pos.dx, by: pos.dy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ dx: d.bx + (e.clientX - d.px), dy: d.by + (e.clientY - d.py) });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const transform = `translate(calc(-50% + ${pos.dx}px), calc(-50% + ${pos.dy}px))`;
  const statusText = status === "calling" ? "呼叫中…" : status === "active" ? "进行中" : status;
  const peerNames = useMemo(() => new Map(roster.map((peer) => [peer.id, peer.name])), [roster]);

  return (
    <>
      {callError ? (
        <div
          className="fixed left-1/2 top-4 z-[210] flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-white"
          style={{ background: "#c42b1c", boxShadow: "var(--taomni-shadow-lg)" }}
          role="alert"
        >
          <span>{callError}</span>
          <button
            type="button"
            onClick={clearCallError}
            className="ml-1 opacity-80 hover:opacity-100"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

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

      {callId && !minimized ? (
        <div
          className="fixed left-1/2 top-1/2 z-[190] flex w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-2xl"
          style={{ transform, background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <div
            className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold"
            style={{ background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))", borderBottom: "1px solid var(--taomni-chrome-border)", cursor: "move", touchAction: "none" }}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
          >
            内网{kind === "video" ? "视频" : "语音"}通话
            <span className="font-normal" style={{ color: "var(--taomni-text-muted)" }}>
              · {statusText}
            </span>
            <span className="ml-auto text-[11px] font-normal" style={{ color: "var(--taomni-text-muted)" }}>
              {isNativeStack
                ? `${Object.keys(remotes).length >= 6 ? "人数较多，原生 mesh 建议 ≤ 6 人 · " : ""}Linux 原生 · P2P`
                : `${Object.keys(remotes).length >= 8 ? "人数较多，mesh 建议 ≤ 8 人 · " : ""}P2P · 无 STUN/TURN`}
            </span>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              onPointerDown={(e) => e.stopPropagation()}
              title="最小化"
              aria-label="最小化"
              className="ml-1 grid h-6 w-6 place-items-center rounded-md"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              <Minus className="h-4 w-4" />
            </button>
          </div>
          <div
            className="grid flex-1 gap-2 p-3"
            style={{ gridTemplateColumns: `repeat(${Math.min(3, 1 + Object.keys(remotes).length)},1fr)`, background: "#070b14" }}
          >
            <VideoTile stream={screenOn ? screenStream : localStream} muted label={screenOn ? "我（共享屏幕）" : "我"} camOff={!screenOn && (!camOn || kind === "audio")} />
            {Object.entries(remotes).map(([peerId, r]) => (
              <VideoTile
                key={peerId}
                stream={r.stream}
                canvas={r.canvas}
                level={levels[peerId]}
                muted={false}
                label={`${peerNames.get(peerId) ?? peerId.slice(0, 6)}${r.screen ? "（共享屏幕）" : ""}`}
                camOff={!r.cam && !r.screen}
              />
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

      {callId && minimized ? (
        <div
          className="fixed left-1/2 top-1/2 z-[190] flex items-center gap-1.5 rounded-full py-1.5 pl-3 pr-2"
          style={{ transform, background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <span
            className="cursor-move select-none pr-1 text-[12px] font-semibold"
            style={{ touchAction: "none" }}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            title="拖动"
          >
            内网{kind === "video" ? "视频" : "语音"}通话 · {statusText}
          </span>
          <RoundBtn
            onClick={toggleMic}
            title={micOn ? "静音" : "取消静音"}
            bg={micOn ? "var(--taomni-card-bg)" : "#374151"}
            color={micOn ? "var(--taomni-text)" : "#9ca3af"}
          >
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </RoundBtn>
          <RoundBtn
            onClick={() => void toggleScreen()}
            title={screenOn ? "停止共享" : "共享屏幕"}
            bg={screenOn ? "var(--taomni-accent)" : "var(--taomni-card-bg)"}
            color={screenOn ? "#fff" : "var(--taomni-text)"}
          >
            <MonitorUp className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn onClick={() => setMinimized(false)} title="展开" bg="var(--taomni-card-bg)" color="var(--taomni-text)">
            <Maximize2 className="h-4 w-4" />
          </RoundBtn>
          <RoundBtn onClick={hangup} title="挂断" bg="#c42b1c" color="#fff">
            <PhoneOff className="h-4 w-4" />
          </RoundBtn>
        </div>
      ) : null}
    </>
  );
}

function RoundBtn({
  onClick,
  title,
  bg,
  color,
  children,
}: {
  onClick: () => void;
  title: string;
  bg: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="grid h-8 w-8 place-items-center rounded-full"
      style={{ background: bg, color, border: "1px solid var(--taomni-card-border)" }}
    >
      {children}
    </button>
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
