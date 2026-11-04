import { useEffect, useRef, useState } from "react";
import { ApiError, request, type Instance } from "./api";

export interface Frame { type: string; [key: string]: unknown }
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];

export function useLive(instance: Instance, path: string, onFrame: (frame: Frame) => void, onStatus: (status: string) => void) {
  const callback = useRef(onFrame);
  const status = useRef(onStatus);
  callback.current = onFrame; status.current = onStatus;
  const channel = useRef<WebSocket | null>(null);
  const restart = useRef<(() => void) | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let lastFrame = Date.now();
    let sequence = 0;
    let connected = false;
    let instanceId: string | undefined;
    let ended = false;
    let denied = false;
    let connecting = false;
    let paused = false;
    const abort = new AbortController();
    setCanRetry(false);
    const connect = async () => {
      if (disposed || ended || denied || connecting || channel.current?.readyState === WebSocket.OPEN) return;
      if (!navigator.onLine) { status.current("离线 · 等待网络恢复"); return; }
      // Retire the previous socket before waiting for a new ticket. Its delayed
      // close must not clear the pending attempt's gate or schedule a rival.
      const previous = socket;
      socket = null;
      if (channel.current === previous) channel.current = null;
      previous?.close();
      connecting = true;
      setCanRetry(false);
      status.current(connected ? "重连中" : "连接中");
      try {
        const { ticket } = await request<{ ticket: string }>(instance, "/ws-ticket", {}, abort.signal);
        if (disposed || ended || denied) return;
        const url = new URL(`${instance.endpoint}/api/v1${path}`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        if (connected) url.searchParams.set("after_seq", String(sequence));
        url.searchParams.set("ticket", ticket); // one-use credential, never the token
        const current = new WebSocket(url);
        lastFrame = Date.now();
        socket = current;
        channel.current = current;
        const reconnect = connected;
        current.onopen = () => {
          if (disposed || socket !== current) return;
          connecting = false;
          lastFrame = Date.now(); status.current("已连接");
          connected = true;
        };
        current.onmessage = event => {
          if (disposed || socket !== current) return;
          lastFrame = Date.now();
          let frame: Frame;
          try { frame = JSON.parse(event.data); } catch { current.close(); return; }
          // A valid application frame establishes recovery; merely opening and
          // immediately dropping a socket must not reset the retry budget.
          attempts = 0;
          if (frame.type === "heartbeat") { current.send(JSON.stringify({ type: "heartbeat-ack" })); return; }
          if (frame.type === "hello") {
            const changed = instanceId !== undefined && frame.instance_id !== instanceId;
            instanceId = typeof frame.instance_id === "string" ? frame.instance_id : undefined;
            if (changed) sequence = 0;
            if (path === "/events" && (!reconnect || changed) && typeof frame.event_seq === "number") sequence = frame.event_seq;
            callback.current(frame); return;
          }
          if (frame.type === "resync") {
            if (typeof frame.last_seq === "number") sequence = frame.last_seq;
            callback.current(frame); return;
          }
          if (frame.type === "exit" || (frame.type === "error" && frame.code === "terminal_not_found")) ended = true;
          if (typeof frame.seq === "number") {
            if (frame.seq <= sequence) return;
            sequence = frame.seq;
          }
          if (typeof frame.last_seq === "number") sequence = frame.last_seq;
          callback.current(frame);
        };
        current.onclose = event => {
          if (channel.current === current) channel.current = null;
          if (disposed || socket !== current) return;
          socket = null;
          connecting = false;
          if (ended || event.code === 4004) { ended = true; status.current("终端已退出或关闭"); return; }
          if (event.code === 4001) { denied = true; status.current("已被实例吊销，请重新配对"); return; }
          retry();
        };
        current.onerror = () => current.close();
      } catch (error) {
        connecting = false;
        if (disposed) return;
        if (error instanceof ApiError && ["unauthorized", "origin_denied"].includes(error.code)) {
          denied = true; status.current("配对已失效，请重新配对"); return;
        }
        retry();
      }
    };
    const retry = () => {
      if (disposed || ended || denied) return;
      clearTimeout(timer);
      if (!navigator.onLine) { status.current("离线 · 等待网络恢复"); return; }
      if (attempts >= RETRY_DELAYS.length) {
        paused = true; status.current("离线 · 自动重连已暂停，请重试"); setCanRetry(true); return;
      }
      status.current("离线 · 重连中");
      timer = setTimeout(connect, RETRY_DELAYS[attempts++]);
    };
    restart.current = () => {
      if (disposed || ended || denied || channel.current?.readyState === WebSocket.OPEN) return;
      clearTimeout(timer); attempts = 0; paused = false; void connect();
    };
    const online = () => { if (!paused) { clearTimeout(timer); void connect(); } };
    const offline = () => {
      if (disposed || ended || denied || paused) return;
      clearTimeout(timer);
      status.current("离线 · 等待网络恢复");
      socket?.close();
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const watchdog = setInterval(() => {
      if (socket && Date.now() - lastFrame > (socket.readyState === 0 ? 15000 : 90000) && socket.readyState <= WebSocket.OPEN) socket.close();
    }, 15000);
    void connect();
    return () => {
      disposed = true; abort.abort(); clearTimeout(timer); clearInterval(watchdog);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      socket?.close(); channel.current = null; restart.current = null;
    };
  }, [instance.id, instance.token, instance.endpoint, path]);

  return {
    canRetry,
    retry: () => restart.current?.(),
    send: (frame: Frame) => {
      if (channel.current?.readyState !== WebSocket.OPEN) return false;
      try { channel.current.send(JSON.stringify(frame)); return true; }
      catch { channel.current.close(); return false; }
    },
  };
}
