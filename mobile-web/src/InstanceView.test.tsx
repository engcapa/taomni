import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenStatus } from "./openSession";
const mock = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn() }));
vi.mock("./live", () => ({ useLive: () => ({ send: vi.fn(), canRetry: false, retry: vi.fn() }) }));
vi.mock("./openSession", () => ({ openSession: mock.open }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), request: mock.request, loadInstances: () => [], saveInstances: vi.fn() }));
import { InstanceView } from "./InstanceView";
const instance = { id: "pc", deviceId: "phone", label: "PC", endpoint: "https://pc.example", token: "t" };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { mock.request.mockReset(); mock.open.mockReset(); mock.open.mockResolvedValue("term:qa-opened"); });
afterEach(cleanup);

it("lists only terminal sessions and excludes agents from the overview counts", async () => {
  mock.request.mockResolvedValue({ sessions: [
    { id: "term:local", kind: "terminal", title: "Local shell", status: "running", summary: "Terminal" },
    { id: "thread:qa-task", kind: "agent", title: "Tao Chat", status: "awaiting_confirmation", summary: "Agent" },
  ], saved_sessions: [], capabilities: { open_sessions: true } });
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findByTestId("mobile-session")).toHaveAttribute("data-session-kind", "terminal");
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(1);
  expect(screen.queryByText("Tao Chat")).toBeNull();
  expect(screen.queryByTestId("mobile-empty-sessions")).toBeNull();
  expect(screen.getByText("正在运行").parentElement).toHaveTextContent(/^1正在运行$/);
  expect(screen.getByText("等待确认").parentElement).toHaveTextContent(/^0等待确认$/);
  expect(screen.getByText("全部会话").parentElement).toHaveTextContent(/^1全部会话$/);
});

it("collapses saved sessions and searches names, types and groups without losing sessions", async () => {
  mock.request.mockResolvedValue({
    sessions: [],
    saved_sessions: [
      { id: "build", name: "Build host", session_type: "SSH", group_path: "Production" },
      { id: "lab", name: "Console", session_type: "Serial", group_path: "Hardware/Lab" },
      { id: "local", name: "Local shell", session_type: "Local", group_path: null },
    ],
    capabilities: { open_sessions: true },
  });
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  const toggle = await screen.findByTestId("mobile-saved-toggle");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("mobile-saved-session")).toBeNull();
  expect(screen.getByTestId("mobile-saved-toggle")).toHaveTextContent("3");

  fireEvent.click(toggle);
  const search = screen.getByTestId("mobile-saved-search");
  expect(search).not.toHaveFocus();
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(3);
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  fireEvent.change(search, { target: { value: "  production  " } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Build host");
  fireEvent.change(search, { target: { value: "serial" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Console");
  fireEvent.change(search, { target: { value: "lab" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Console");
  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.queryByTestId("mobile-saved-session")).toBeNull();
  expect(screen.getByTestId("mobile-saved-empty-search")).toHaveTextContent("没有匹配");
  fireEvent.click(screen.getByTestId("mobile-saved-search-clear"));
  expect(search).toHaveValue("");
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(3);
  fireEvent.change(search, { target: { value: "BUILD" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Build host");
  fireEvent.click(screen.getByTestId("mobile-saved-toggle"));
  expect(screen.queryByTestId("mobile-saved-search")).toBeNull();
  fireEvent.click(screen.getByTestId("mobile-saved-toggle"));
  expect(screen.getByTestId("mobile-saved-search")).toHaveValue("");
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(3);
  fireEvent.click(screen.getAllByTestId("mobile-saved-open")[0]);
  expect(mock.open).toHaveBeenCalledWith(instance, { kind: "saved", saved_session_id: "build" }, expect.any(AbortSignal), expect.any(Function));
  await act(async () => {});
});

it("opens a single saved session directly and still lets the user collapse it", async () => {
  mock.request.mockResolvedValue({ sessions: [], saved_sessions: [
    { id: "build", name: "Build host", session_type: "SSH", group_path: "QA" },
  ], capabilities: { open_sessions: true } });
  const onSelect = vi.fn();
  render(<InstanceView instance={instance} onSelect={onSelect} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  const toggle = await screen.findByTestId("mobile-saved-toggle");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("mobile-saved-open")).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("mobile-saved-open")).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByTestId("mobile-saved-open"));
  await act(async () => {});
  expect(onSelect).toHaveBeenCalledWith("term:qa-opened");
});

it("keeps malformed JSON session responses out of rendering and retains an actionable error", async () => {
  mock.request.mockResolvedValue({});
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findByTestId("mobile-instance-error")).toHaveTextContent("有效的 Taomni API");
  expect(screen.getByTestId("mobile-empty-sessions")).toBeInTheDocument();
});

it.each(["success", "failure"])("late A cancellation %s cannot abort or clear B", async result => {
  const a = deferred<string>(); const b = deferred<string>(); const cancel = deferred<unknown>();
  const calls: { signal: AbortSignal; progress: (status: OpenStatus) => void }[] = [];
  mock.request.mockImplementation((_instance, path) => path === "/sessions" ? Promise.resolve({ sessions: [], saved_sessions: [], capabilities: { open_sessions: true } }) : cancel.promise);
  mock.open.mockImplementation((_instance, _target, signal, progress) => { calls.push({ signal, progress }); return calls.length === 1 ? a.promise : b.promise; });
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByTestId("mobile-open-local"));
  act(() => calls[0].progress({ request_id: "A", status: "pending" }));
  fireEvent.click(screen.getByText("取消连接"));
  await act(async () => { a.reject(new Error("A ended")); });
  fireEvent.click(screen.getByTestId("mobile-open-local"));
  act(() => calls[1].progress({ request_id: "B", status: "pending", auth: { id: "B-auth", name: "B challenge", instructions: "", prompts: [{ prompt: "OTP", echo: false, initial: "" }] } }));
  await act(async () => { if (result === "success") cancel.resolve({}); else cancel.reject(new Error("late A error")); });
  expect(calls[1].signal.aborted).toBe(false);
  expect(screen.getByTestId("mobile-connection-auth")).toHaveTextContent("B challenge");
  expect(screen.getByTestId("mobile-open-status")).not.toHaveTextContent("late A error");
  expect(screen.getByTestId("mobile-open-local")).toBeDisabled();
});
