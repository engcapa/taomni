import { act, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { type VncConnectionState } from "../../../../stores/vncStore";
import VncPanel from "../../VncPanel";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown; }) => void>(),
  window: { current: null as Record<string, unknown> | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (!mocks.window.current) throw new Error("no Tauri window in this test");
    return mocks.window.current;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown; }) => void) => {
    mocks.listeners.set(name, handler);
    return Promise.resolve(() => {
      if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name);
    });
  }),
}));

export class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

export const CONNECTED: VncConnectionState = {
  status: "connected",
  sessionId: "vnc-session",
  wsPort: 41000,
  width: 1920,
  height: 1080,
  name: "windows-host",
  protocol: "RFB 3.8",
  security: "VNC Authentication",
  encrypted: false,
  error: null,
};

export function sentMessages(socket: MockWebSocket): Array<{ kind: "key"; down: boolean; keysym: number; } | { kind: "pointer"; buttons: number; x: number; y: number; }> {
  return socket.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is ArrayBuffer => payload instanceof ArrayBuffer)
    .map((payload) => {
      const view = new DataView(payload);
      if (view.getUint8(0) === 2) {
        return { kind: "key" as const, down: view.getUint8(1) === 1, keysym: view.getUint32(2) };
      }
      if (view.getUint8(0) === 3) {
        return { kind: "pointer" as const, buttons: view.getUint8(1), x: view.getUint16(2), y: view.getUint16(4) };
      }
      return null;
    })
    .filter((message): message is NonNullable<typeof message> => message !== null);
}

export function sentText(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is string => typeof payload === "string")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

export async function renderConnected(
  props: Partial<Parameters<typeof VncPanel>[0]> = {},
  connected: Record<string, unknown> = {},
) {
  render(
    <VncPanel tabId="vnc-tab" host="windows.example.test" port={5900} visible {...props} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const socket = MockWebSocket.instances[0];
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "connected", width: 1920, height: 1080, name: "fixture", protocol: "3.8", security: "VNCAuth",
        encrypted: false, ...connected,
      }),
    } as MessageEvent);
  });
  const canvas = screen.getByTestId("vnc-canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  act(() => canvas.focus());
  socket.send.mockClear();
  return { socket, canvas };
}

export function connectCalls() {
  return mocks.invoke.mock.calls.filter(([command]) => command === "vnc_connect");
}

export { mocks };
