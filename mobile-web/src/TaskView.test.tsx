import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskView } from "./TaskView";
import { ApiError, request, type Instance } from "./api";
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), request: vi.fn() }));
it("retains independently dated changes and file data when only task refresh succeeds, then recovers", async () => {
  let clock = "10:00:00";
  vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(() => clock);
  let failed = false;
  vi.mocked(request).mockImplementation(async (_instance, path) => {
    if (path.endsWith("/changes")) {
      if (failed) throw new ApiError("connection_failed");
      return { changes: [{ path: "hello.txt", change_kind: "M", diff_available: true }] };
    }
    if (path.includes("/files?")) {
      if (failed) throw new ApiError("connection_failed");
      return { path: "hello.txt", content: "retained file", truncated: false };
    }
    return { id: "thread:t", status: "idle", tools: [], confirmations: [] };
  });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  const session = { id: "thread:t", title: "Task", kind: "agent" as const, status: "idle", summary: "" };
  const { rerender } = render(<TaskView instance={instance} session={session} revision={0} />);
  fireEvent.click(await screen.findByTestId("mobile-file-open"));
  await screen.findByText("retained file");
  expect(screen.getByTestId("mobile-changes-updated")).toHaveTextContent("10:00:00");
  failed = true;
  clock = "11:00:00";
  rerender(<TaskView instance={instance} session={session} revision={1} />);
  await screen.findByTestId("mobile-changes-error");
  await screen.findByTestId("mobile-file-error");
  expect(screen.getByTestId("mobile-task-updated")).toHaveTextContent("11:00:00");
  expect(screen.getByTestId("mobile-task-updated")).not.toHaveTextContent("可能已过期");
  expect(screen.getByTestId("mobile-changes-updated")).toHaveTextContent("10:00:00 · 可能已过期");
  expect(screen.getByTestId("mobile-file-updated")).toHaveTextContent("10:00:00 · 可能已过期");
  expect(screen.getByTestId("mobile-file-content")).toHaveTextContent("retained file");
  failed = false;
  clock = "12:00:00";
  fireEvent.click(screen.getByTestId("mobile-changes-refresh"));
  fireEvent.click(screen.getByTestId("mobile-file-refresh"));
  await waitFor(() => expect(screen.getByTestId("mobile-file-updated")).toHaveTextContent("12:00:00"));
  expect(screen.getByTestId("mobile-changes-updated")).toHaveTextContent("12:00:00");
  expect(screen.queryByTestId("mobile-file-error")).toBeNull();
  expect(screen.queryByTestId("mobile-changes-error")).toBeNull();
  rerender(<TaskView instance={instance} session={session} revision={1} stale />);
  expect(screen.getByTestId("mobile-task-updated")).toHaveTextContent("可能已过期");
  expect(screen.getByTestId("mobile-changes-updated")).toHaveTextContent("可能已过期");
  expect(screen.getByTestId("mobile-file-updated")).toHaveTextContent("可能已过期");
});

it("keeps a second instruction blocked when a revision supersedes the post-send status refresh", async () => {
  const pending: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = [];
  let initial = true;
  vi.mocked(request).mockImplementation(async (_instance, path, _body, signal) => {
    if (path.endsWith("/message")) return {};
    if (path.endsWith("/changes")) return { changes: [] };
    if (initial) { initial = false; return { id: "thread:t", status: "idle" }; }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, signal });
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  const session = { id: "thread:t", title: "Task", kind: "agent" as const, status: "idle", summary: "" };
  const { rerender } = render(<TaskView instance={instance} session={session} revision={0} />);
  const input = screen.getByTestId("mobile-agent-input");
  await waitFor(() => expect(screen.getByTestId("mobile-task-updated")).not.toHaveTextContent("—"));
  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.click(screen.getByTestId("mobile-agent-send"));
  await waitFor(() => expect(pending).toHaveLength(1));
  rerender(<TaskView instance={instance} session={session} revision={1} />);
  await waitFor(() => expect(pending[0].signal?.aborted).toBe(true));
  expect(pending).toHaveLength(2);
  fireEvent.change(input, { target: { value: "second" } });
  await waitFor(() => expect(screen.getByTestId("mobile-agent-send")).toBeEnabled());
  fireEvent.click(screen.getByTestId("mobile-agent-send"));
  await waitFor(() => expect(pending).toHaveLength(3));
  expect(pending[1].signal?.aborted).toBe(true);
  pending[2].resolve({ id: "thread:t", status: "running" });
  await waitFor(() => expect(screen.getByTestId("mobile-task-error")).toHaveTextContent("当前轮次仍在运行"));
  expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(1);
  await waitFor(() => expect(screen.getByTestId("mobile-task-status")).toHaveTextContent("运行中"));
  expect(screen.getByTestId("mobile-agent-send")).toBeDisabled();
});

it("sends one instruction after an in-flight status refresh resolves", async () => {
  const pending: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = [];
  let initial = true;
  vi.mocked(request).mockImplementation(async (_instance, path, _body, signal) => {
    if (path.endsWith("/message")) return {};
    if (path.endsWith("/changes")) return { changes: [] };
    if (initial) { initial = false; return { id: "thread:t", status: "idle" }; }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, signal });
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  const session = { id: "thread:t", title: "Task", kind: "agent" as const, status: "idle", summary: "" };
  const { rerender } = render(<TaskView instance={instance} session={session} revision={0} />);
  await waitFor(() => expect(screen.getByTestId("mobile-task-updated")).not.toHaveTextContent("—"));
  rerender(<TaskView instance={instance} session={session} revision={1} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  const input = screen.getByTestId("mobile-agent-input");
  fireEvent.change(input, { target: { value: "继续" } });
  const send = screen.getByTestId("mobile-agent-send");
  expect(send).toBeEnabled();
  fireEvent.click(send);
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0].signal?.aborted).toBe(true);
  pending[1].resolve({ id: "thread:t", status: "idle" });
  await waitFor(() => expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(1));
  await waitFor(() => expect(pending).toHaveLength(3));
  pending[2].resolve({ id: "thread:t", status: "idle" });
  await waitFor(() => expect(input).toHaveValue(""));
  expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(1);
});

it("still sends with Ctrl/Cmd+Enter through the authoritative submit path", async () => {
  vi.mocked(request).mockImplementation(async (_instance, path) => path.endsWith("/changes") ? { changes: [] } : { id: "thread:t", status: "idle" });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  render(<TaskView instance={instance} session={{ id: "thread:t", title: "Task", kind: "agent", status: "idle", summary: "" }} revision={0} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const input = screen.getByTestId("mobile-agent-input");
  fireEvent.change(input, { target: { value: "继续" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(1));
});

it("sends nothing and reports why when the authoritative status is running", async () => {
  const pending: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = [];
  let initial = true;
  vi.mocked(request).mockImplementation(async (_instance, path, _body, signal) => {
    if (path.endsWith("/message")) return {};
    if (path.endsWith("/changes")) return { changes: [] };
    if (initial) { initial = false; return { id: "thread:t", status: "idle" }; }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, signal });
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  const session = { id: "thread:t", title: "Task", kind: "agent" as const, status: "idle", summary: "" };
  const { rerender } = render(<TaskView instance={instance} session={session} revision={0} />);
  await waitFor(() => expect(screen.getByTestId("mobile-task-updated")).not.toHaveTextContent("—"));
  rerender(<TaskView instance={instance} session={session} revision={1} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  const input = screen.getByTestId("mobile-agent-input");
  fireEvent.change(input, { target: { value: "继续" } });
  fireEvent.click(screen.getByTestId("mobile-agent-send"));
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0].signal?.aborted).toBe(true);
  pending[1].resolve({ id: "thread:t", status: "running" });
  await waitFor(() => expect(screen.getByTestId("mobile-task-error")).toHaveTextContent("当前轮次仍在运行"));
  expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(0);
  await waitFor(() => expect(screen.getByTestId("mobile-task-status")).toHaveTextContent("运行中"));
  expect(screen.getByTestId("mobile-task-error")).toBeVisible();
  expect(input).toHaveValue("继续");
});

it("fails closed on an unreadable task status and lets the user retry before sending", async () => {
  let failed = true;
  vi.mocked(request).mockImplementation(async (_instance, path) => {
    if (path.endsWith("/changes")) return { changes: [] };
    if (failed) throw new ApiError("connection_failed");
    return { id: "thread:t", status: "idle" };
  });
  const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
  render(<TaskView instance={instance} session={{ id: "thread:t", title: "Task", kind: "agent", status: "idle", summary: "" }} revision={0} />);
  await screen.findByTestId("mobile-task-retry");
  fireEvent.change(screen.getByTestId("mobile-agent-input"), { target: { value: "retained draft" } });
  const send = screen.getByTestId("mobile-agent-send");
  expect(send).toBeEnabled();
  fireEvent.click(send);
  await waitFor(() => expect(screen.getByTestId("mobile-task-error")).toHaveTextContent("连接失败"));
  expect(vi.mocked(request).mock.calls.filter(([, path]) => path.endsWith("/message"))).toHaveLength(0);
  failed = false;
  fireEvent.click(screen.getByTestId("mobile-task-retry"));
  await waitFor(() => expect(screen.getByTestId("mobile-agent-send")).toBeEnabled());
  expect(screen.getByTestId("mobile-agent-input")).toHaveValue("retained draft");
});

it("counts UTF-8 bytes and keeps oversized Chinese instructions from being submitted", async () => {
  vi.mocked(request).mockImplementation(async (_instance, path) => path.endsWith("/changes") ? { changes: [] } : { id:"thread:t", status:"idle", tools:[], confirmations:[] });
  const instance: Instance = { id:"phone", endpoint:"https://pc.example", token:"t", deviceId:"d", label:"PC" };
  render(<TaskView instance={instance} session={{ id:"thread:t", title:"Task", kind:"agent", status:"idle", summary:"" }} revision={0} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const input = screen.getByTestId("mobile-agent-input");
  fireEvent.change(input, { target: { value:"中".repeat(11000) } });
  expect(screen.getByRole("alert")).toHaveTextContent("33000 / 32768 UTF-8 字节");
  expect(screen.getByTestId("mobile-agent-send")).toBeDisabled();
  fireEvent.submit(input.closest("form")!);
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value:"继续" } });
  expect(screen.getByTestId("mobile-agent-send")).toBeEnabled();
});
