import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenStatus } from "./openSession";
const mock = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn() }));
vi.mock("./live", () => ({ useLive: () => ({ send: vi.fn(), canRetry: false, retry: vi.fn() }) }));
vi.mock("./openSession", () => ({ openSession: mock.open }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), request: mock.request, loadInstances: () => [], saveInstances: vi.fn() }));
import { ApiError } from "./api";
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

it("shows eight terminal sessions per batch and searches titles and summaries across the full list", async () => {
  mock.request.mockResolvedValue({
    sessions: Array.from({ length: 20 }, (_, index) => ({
      id: `term:${index}`, kind: "terminal", title: `Terminal ${String(index).padStart(2, "0")}`,
      status: "running", summary: index === 17 ? "Database maintenance" : `Summary ${index}`,
    })),
    saved_sessions: [], capabilities: { open_sessions: true },
  });
  const onSelect = vi.fn();
  render(<InstanceView instance={instance} onSelect={onSelect} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findAllByTestId("mobile-session")).toHaveLength(8);
  expect(screen.getByTestId("mobile-sessions-result-count")).toHaveTextContent("共 20 个会话，当前显示 8 条");
  expect(screen.getByText("全部会话").parentElement).toHaveTextContent(/^20全部会话$/);
  fireEvent.click(screen.getByTestId("mobile-sessions-more"));
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(16);
  fireEvent.click(screen.getByTestId("mobile-sessions-more"));
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(20);
  expect(screen.queryByTestId("mobile-sessions-more")).toBeNull();

  const search = screen.getByTestId("mobile-sessions-search");
  fireEvent.change(search, { target: { value: "  DATABASE  " } });
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-session")).toHaveTextContent("Database maintenance");
  fireEvent.click(screen.getByTestId("mobile-sessions-search-clear"));
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(8);
  fireEvent.change(search, { target: { value: `missing-${"x".repeat(240)}` } });
  expect(screen.queryByTestId("mobile-session")).toBeNull();
  expect(screen.getByTestId("mobile-sessions-empty-search")).toHaveClass("session-empty-search");
  expect(screen.getByTestId("mobile-sessions-empty-search")).toHaveTextContent("没有匹配");
  fireEvent.click(screen.getByTestId("mobile-sessions-search-clear"));
  fireEvent.change(search, { target: { value: "terminal 12" } });
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("mobile-session"));
  expect(onSelect).toHaveBeenCalledWith("term:12");
});

it("batches saved sessions and searches all names, types and groups without losing sessions", async () => {
  const extra = Array.from({ length: 17 }, (_, index) => ({ id: `extra-${index}`, name: `Archive ${String(index).padStart(2, "0")}`, session_type: "SSH", group_path: "Overflow/Long" }));
  mock.request.mockResolvedValue({
    sessions: [],
    saved_sessions: [
      { id: "build", name: "Build host", session_type: "SSH", group_path: "Production" },
      { id: "lab", name: "Console", session_type: "Serial", group_path: "Hardware/Lab" },
      { id: "local", name: "Local shell", session_type: "Local", group_path: null },
      ...extra,
    ],
    capabilities: { open_sessions: true },
  });
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findAllByTestId("mobile-saved-session")).toHaveLength(8);
  expect(screen.queryByTestId("mobile-saved-toggle")).toBeNull();
  expect(screen.getByTestId("mobile-saved-result-count")).toHaveTextContent("共 20 个会话，当前显示 8 条");
  fireEvent.click(screen.getByTestId("mobile-saved-more"));
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(16);
  fireEvent.click(screen.getByTestId("mobile-saved-more"));
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(20);
  expect(screen.queryByTestId("mobile-saved-more")).toBeNull();

  const search = screen.getByTestId("mobile-saved-search");
  fireEvent.change(search, { target: { value: "未分组" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Local shell");
  fireEvent.change(search, { target: { value: "  production  " } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Build host");
  fireEvent.change(search, { target: { value: "serial" } });
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Console");
  fireEvent.change(search, { target: { value: "archive 16" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Archive 16");
  fireEvent.change(search, { target: { value: `missing-${"x".repeat(240)}` } });
  expect(screen.queryByTestId("mobile-saved-session")).toBeNull();
  expect(screen.getByTestId("mobile-saved-empty-search")).toHaveClass("session-empty-search");
  fireEvent.click(screen.getByTestId("mobile-saved-search-clear"));
  expect(search).toHaveValue("");
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(8);
  fireEvent.change(search, { target: { value: "BUILD" } });
  expect(screen.getAllByTestId("mobile-saved-session")).toHaveLength(1);
  fireEvent.click(screen.getAllByTestId("mobile-saved-open")[0]);
  expect(mock.open).toHaveBeenCalledWith(instance, { kind: "saved", saved_session_id: "build" }, expect.any(AbortSignal), expect.any(Function));
  await act(async () => {});
});

it("moves keyboard focus into newly revealed sessions", async () => {
  mock.request.mockResolvedValue({
    sessions: Array.from({ length: 20 }, (_, index) => ({ id: `term:${index}`, kind: "terminal", title: `Terminal ${String(index).padStart(2, "0")}`, status: "running", summary: `Summary ${index}` })),
    saved_sessions: [], capabilities: { open_sessions: true },
  });
  const user = userEvent.setup();
  render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  const more = await screen.findByTestId("mobile-sessions-more");
  more.focus();
  await user.keyboard("{Enter}");
  expect(screen.getAllByTestId("mobile-session")).toHaveLength(16);
  expect(screen.getAllByTestId("mobile-session")[8]).toHaveFocus();
  await user.tab();
  expect(screen.getAllByTestId("mobile-session")[9]).toHaveFocus();
});

it("matches ASCII case consistently under a Turkish browser locale", async () => {
  const original = String.prototype.toLocaleLowerCase;
  const locale = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function(this: string) {
    return original.call(this, "tr-TR");
  });
  try {
    mock.request.mockResolvedValue({
      sessions: [{ id: "term:12", kind: "terminal", title: "Terminal 12", status: "running", summary: "Database maintenance" }],
      saved_sessions: [{ id: "build", name: "Build host", session_type: "SSH", group_path: "Production" }],
      capabilities: { open_sessions: true },
    });
    render(<InstanceView instance={instance} onSelect={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
    fireEvent.change(await screen.findByTestId("mobile-sessions-search"), { target: { value: "TERMINAL 12" } });
    expect(screen.getByTestId("mobile-session")).toHaveTextContent("Terminal 12");
    fireEvent.change(screen.getByTestId("mobile-sessions-search"), { target: { value: "terminal 12" } });
    expect(screen.getByTestId("mobile-session")).toHaveTextContent("Terminal 12");
    fireEvent.change(screen.getByTestId("mobile-saved-search"), { target: { value: "BUILD" } });
    expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Build host");
    fireEvent.change(screen.getByTestId("mobile-saved-search"), { target: { value: "build" } });
    expect(screen.getByTestId("mobile-saved-session")).toHaveTextContent("Build host");
  } finally { locale.mockRestore(); }
});

it("opens a single saved session directly without a more button", async () => {
  mock.request.mockResolvedValue({
    sessions: [],
    saved_sessions: [{ id: "build", name: "Build host", session_type: "SSH", group_path: "QA" }],
    capabilities: { open_sessions: true },
  });
  const onSelect = vi.fn();
  render(<InstanceView instance={instance} onSelect={onSelect} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findByTestId("mobile-saved-open")).toBeInTheDocument();
  expect(screen.queryByTestId("mobile-saved-more")).toBeNull();
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

it("offers the desktop & browser entry when desktop_control is advertised and renders desktop view when active", async () => {
  const onOpenDesktop = vi.fn();
  mock.request.mockImplementation(async (_inst, path: string) => {
    if (path === "/sessions") {
      return { sessions: [], saved_sessions: [], capabilities: { open_sessions: true, screen_capture: false, desktop_control: true } };
    }
    if (path === "/desktop/screen") throw new ApiError("screen_capture_disabled");
    if (path === "/desktop/windows") return { windows: [], screen_capture_enabled: false };
    throw new Error(`unexpected ${path}`);
  });
  const { rerender } = render(<InstanceView instance={instance} onSelect={vi.fn()} onOpenDesktop={onOpenDesktop} onCloseDesktop={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByTestId("mobile-open-desktop"));
  expect(onOpenDesktop).toHaveBeenCalledTimes(1);

  rerender(<InstanceView instance={instance} desktop onSelect={vi.fn()} onOpenDesktop={onOpenDesktop} onCloseDesktop={vi.fn()} onCloseSession={vi.fn()} onBack={vi.fn()} />);
  expect(await screen.findByTestId("mobile-desktop-view")).toBeInTheDocument();
});
