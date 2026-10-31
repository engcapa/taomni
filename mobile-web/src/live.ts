import { useEffect, useRef } from "react";
import { ApiError, request, type Instance } from "./api";
export interface Frame { type: string; [key: string]: unknown }
export function useLive(instance: Instance, path: string, onFrame: (frame: Frame) => void, onStatus: (status: string) => void) {
  const callback = useRef(onFrame);
  const status = useRef(onStatus);
  callback.current = onFrame; status.current = onStatus;
  const channel = useRef<WebSocket | null>(null);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let lastFrame = Date.now();
    let sequence = 0;
    let connected = false;
    const abort = new AbortController();
    const connect = async () => {
      status.current(connected ? "重连中" : "连接中");
      try {
        const { ticket } = await request<{ ticket: string }>(instance, "/ws-ticket", {}, abort.signal);
        if (disposed) return;
        const url = new URL(`${instance.endpoint}/api/v1${path}`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        if (connected) url.searchParams.set("after_seq", String(sequence));
        url.searchParams.set("ticket", ticket); // one-use credential, never the token
        socket = new WebSocket(url);
        channel.current = socket;
        const reconnect = connected;
        socket.onopen = () => {
          lastFrame = Date.now(); attempts = 0; status.current("已连接");
          connected = true;
        };
        socket.onmessage = event => {
          lastFrame = Date.now();
          let frame: Frame;
          try { frame = JSON.parse(event.data); } catch { socket?.close(); return; }
          if (frame.type === "heartbeat") { socket?.send(JSON.stringify({ type: "heartbeat-ack" })); return; }
          if (frame.type === "hello") {
            if (path === "/events" && !reconnect && typeof frame.event_seq === "number") sequence = frame.event_seq;
            callback.current(frame); return;
          }
          // Reconnected terminals resume the retained client buffer. The
          // automatic initial replay belongs to new viewers only.
          if (typeof frame.seq === "number") {
            if (frame.seq <= sequence) return;
            sequence = frame.seq;
          }
          if (typeof frame.last_seq === "number") sequence = frame.last_seq;
          callback.current(frame);
        };
        socket.onclose = event => { if (channel.current === socket) channel.current = null; if (disposed) return; if (event.code === 4001) { status.current("已被实例吊销，请重新配对"); return; } retry(); };
        socket.onerror = () => socket?.close();
      } catch (error) {
        if (error instanceof ApiError && ["unauthorized", "origin_denied"].includes(error.code)) { status.current("配对已失效，请重新配对"); return; }
        retry();
      }
    };
    const retry = () => {
      if (disposed) return;
      status.current("离线 · 重连中");
      timer = setTimeout(connect, [1000, 2000, 5000, 10000, 30000][Math.min(attempts++, 4)]);
    };
    const watchdog = setInterval(() => { if (socket?.readyState === WebSocket.OPEN && Date.now() - lastFrame > 90000) socket.close(); }, 15000);
    void connect();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); clearInterval(watchdog); socket?.close(); channel.current = null; };
  }, [instance.id, instance.token, instance.endpoint, path]);
  return (frame: Frame) => {
    if (channel.current?.readyState !== WebSocket.OPEN) return false;
    channel.current.send(JSON.stringify(frame)); return true;
  };
}
