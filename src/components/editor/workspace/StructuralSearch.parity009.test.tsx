import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StructuralMatch,
  StructuralSearchCapabilities,
  StructuralSearchRequest,
  StructuralSearchResponse,
} from "../../../lib/editor/structuralSearch";
import { StructuralSearchDialog } from "./StructuralSearchDialog";
import { StructuralSearchPanel } from "./panels/StructuralSearchPanel";
import { useStructuralSearchSession } from "./useStructuralSearchSession";

// ED-PARITY-009 renderer lifecycle. The IPC wrappers are mocked: these tests
// prove request identity, typed states and UI wiring. AST correctness is proven
// by src-tauri structural_search.rs tests and the native case.

const ipc = vi.hoisted(() => ({
  structuralSearchCapabilities: vi.fn(),
  structuralSearchRun: vi.fn(),
  structuralSearchCancel: vi.fn(),
}));

vi.mock("../../../lib/editor/structuralSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/editor/structuralSearch")>();
  return { ...actual, ...ipc };
});

const BACKEND = { id: "tree-sitter-java", parser: "tree-sitter 0.25.10", grammar: "tree-sitter-java 0.23.5" };
const CAPS: StructuralSearchCapabilities = {
  available: true, backend: BACKEND, languages: ["java"], scopes: ["workspace", "module", "file"], activeRequests: 0,
};

function match(line: number, arg: string, lineText: string, endLine = line, endCharacter = lineText.length): StructuralMatch {
  return {
    rootId: "root", rootName: "parity009", path: "src/StructuralTarget.java",
    start: { line, character: 4 }, end: { line: endLine, character: endCharacter },
    startByte: 0, endByte: 0, lineText, matchedText: lineText.trim(),
    captures: [{ name: "arg", text: arg, start: { line, character: 23 }, end: { line, character: 23 + arg.length } }],
    containers: [{ kind: "class", name: "StructuralTarget" }, { kind: "method", name: "run" }],
  };
}

const THREE = [
  match(2, "\"alpha\"", "    System.out.println(\"alpha\");"),
  match(3, "42", "    System.out.println(42);"),
  match(4, "\"beta\"", "    System.out.println(", 5, 16),
];

function ok(requestId: string, matches: StructuralMatch[]): StructuralSearchResponse {
  return {
    status: "ok", requestId, backend: BACKEND, matches, truncated: false,
    stats: { filesScanned: 1, filesWithParseErrors: 0, elapsedMs: 3 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const onOpenMatch = vi.fn();
const onStatus = vi.fn();

function Harness() {
  const session = useStructuralSearchSession({
    roots: [{ id: "root", name: "parity009", path: "/fx/parity009" }],
    activeFile: { rootId: "root", path: "src/StructuralTarget.java" },
    onShowResults: () => undefined,
    onStatus,
  });
  return (
    <>
      <button type="button" onClick={session.open}>Search Structurally…</button>
      <StructuralSearchDialog session={session} />
      <StructuralSearchPanel session={session} onOpenMatch={onOpenMatch} />
    </>
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Search Structurally…" }));
  await waitFor(() => expect(screen.getByTestId("structural-search-dialog")).toBeInTheDocument());
  await waitFor(() => expect(ipc.structuralSearchCapabilities).toHaveBeenCalled());
}

function lastRequest(): StructuralSearchRequest {
  return ipc.structuralSearchRun.mock.calls.at(-1)![0] as StructuralSearchRequest;
}

describe("Structural Search session ED-PARITY-009", () => {
  beforeEach(() => {
    for (const mock of Object.values(ipc)) mock.mockReset();
    onOpenMatch.mockReset();
    onStatus.mockReset();
    ipc.structuralSearchCapabilities.mockResolvedValue(CAPS);
    ipc.structuralSearchCancel.mockResolvedValue(true);
    ipc.structuralSearchRun.mockImplementation(async (request: StructuralSearchRequest) => ok(request.requestId, THREE));
  });

  afterEach(() => cleanup());

  it("finds the default Java template In Project and renders class → method → locations", async () => {
    render(<Harness />);
    await openDialog();
    expect(screen.getByTestId("structural-search-template")).toHaveValue("System.out.println($arg$);");
    expect(screen.getByTestId("structural-search-template")).toHaveFocus();
    expect(screen.getByTestId("structural-search-language")).toHaveValue("java");
    expect(screen.getByTestId("structural-search-scope-workspace")).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByTestId("structural-search-variable-row").map((row) => row.dataset.variable)).toEqual(["arg"]);

    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.queryByTestId("structural-search-dialog")).toBeNull());

    const request = lastRequest();
    expect(request.query).toMatchObject({
      schemaVersion: 1, languageId: "java", pattern: "System.out.println($arg$);", scope: "workspace", matchCase: false,
      variables: { arg: { minCount: 1, maxCount: 1, invert: false } },
    });
    expect(request.activeFile).toEqual({ rootId: "root", path: "src/StructuralTarget.java" });
    expect(screen.getByTestId("structural-search-summary")).toHaveTextContent("3 results");
    const nodes = screen.getAllByTestId("structural-search-node").map((node) => `${node.dataset.kind}:${node.textContent}`);
    expect(nodes).toEqual([
      "file:src/StructuralTarget.java3 results",
      "class:StructuralTarget3 results",
      "method:run()3 results",
    ]);
    expect(screen.getAllByTestId("structural-search-match").map((row) => row.dataset.line)).toEqual(["3", "4", "5"]);
    expect(screen.getByTestId("structural-search-backend")).toHaveTextContent("tree-sitter-java 0.23.5");

    fireEvent.click(screen.getAllByTestId("structural-search-match")[1]!);
    expect(onOpenMatch).toHaveBeenLastCalledWith(THREE[1], { preview: true });
    const results = screen.getByTestId("structural-search-results");
    fireEvent.keyDown(results, { key: "ArrowDown" });
    expect(onOpenMatch).toHaveBeenLastCalledWith(THREE[2], { preview: true });
    fireEvent.keyDown(results, { key: "Enter" });
    expect(onOpenMatch).toHaveBeenLastCalledWith(THREE[2], { preview: false });

    const method = screen.getAllByTestId("structural-search-node")[2]!;
    fireEvent.click(within(method).getByRole("button", { name: "Collapse run()" }));
    expect(screen.queryAllByTestId("structural-search-match")).toHaveLength(0);
  });

  it("sends the $arg$ Text modifier and distinguishes one result from an empty result", async () => {
    render(<Harness />);
    await openDialog();
    fireEvent.change(screen.getByTestId("structural-search-variable-text"), { target: { value: "42" } });
    ipc.structuralSearchRun.mockImplementationOnce(async (request: StructuralSearchRequest) => ok(request.requestId, [THREE[1]!]));
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getByTestId("structural-search-summary")).toHaveTextContent("1 result"));
    expect(lastRequest().query.variables.arg).toMatchObject({ text: "42", invert: false });
    expect(screen.getAllByTestId("structural-search-match").map((row) => row.dataset.line)).toEqual(["4"]);

    fireEvent.click(screen.getByTestId("structural-search-edit-query"));
    await waitFor(() => expect(screen.getByTestId("structural-search-variable-text")).toHaveValue("42"));
    fireEvent.change(screen.getByTestId("structural-search-variable-text"), { target: { value: "999" } });
    ipc.structuralSearchRun.mockImplementationOnce(async (request: StructuralSearchRequest) => ok(request.requestId, []));
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getByTestId("structural-search-empty")).toBeInTheDocument());
    expect(lastRequest().query.variables.arg).toMatchObject({ text: "999" });
    expect(screen.getByTestId("structural-search-panel")).toHaveAttribute("data-phase", "empty");
    expect(screen.queryByTestId("structural-search-unavailable")).toBeNull();
  });

  it("still runs under React StrictMode double mounting (dev runtime)", async () => {
    render(<StrictMode><Harness /></StrictMode>);
    await openDialog();
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getByTestId("structural-search-summary")).toHaveTextContent("3 results"));
    expect(screen.queryByTestId("structural-search-unavailable")).toBeNull();
  });

  it("keeps Find disabled with a typed unavailable banner when the backend is missing", async () => {
    ipc.structuralSearchCapabilities.mockResolvedValue({ ...CAPS, available: false });
    render(<Harness />);
    await openDialog();
    await waitFor(() => expect(screen.getByTestId("structural-search-unavailable")).toBeInTheDocument());
    expect(screen.getByTestId("structural-search-find")).toBeDisabled();
    expect(ipc.structuralSearchRun).not.toHaveBeenCalled();
  });

  it("shows unavailable (not empty) for an unavailable response and keeps invalid templates in the dialog", async () => {
    render(<Harness />);
    await openDialog();
    ipc.structuralSearchRun.mockImplementationOnce(async (request: StructuralSearchRequest) => ({
      status: "error", requestId: request.requestId, code: "invalid-pattern",
      message: "Search template is not a single Java statement, expression or class member",
    }));
    fireEvent.change(screen.getByTestId("structural-search-template"), { target: { value: "System.out.println($arg$" } });
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getByTestId("structural-search-error")).toHaveTextContent("not a single Java statement"));
    expect(screen.getByTestId("structural-search-dialog")).toHaveAttribute("data-phase", "error");

    ipc.structuralSearchRun.mockImplementationOnce(async (request: StructuralSearchRequest) => ({
      status: "unavailable", requestId: request.requestId, reason: "backend-missing", message: "Load Java grammar failed",
    }));
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getAllByTestId("structural-search-unavailable").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("structural-search-empty")).toBeNull();
  });

  it("Esc cancels the running request, releases it and drops the late response", async () => {
    const late = deferred<StructuralSearchResponse>();
    ipc.structuralSearchRun.mockImplementationOnce(() => late.promise);
    render(<Harness />);
    await openDialog();
    fireEvent.click(screen.getByTestId("structural-search-find"));
    await waitFor(() => expect(screen.getByTestId("structural-search-running")).toBeInTheDocument());
    const { requestId } = lastRequest();

    // Find is disabled while running, so focus is no longer inside the dialog.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("structural-search-dialog")).toBeNull();
    await waitFor(() => expect(ipc.structuralSearchCancel).toHaveBeenCalledWith(requestId));
    expect(onStatus).toHaveBeenLastCalledWith("Structural search cancelled");

    await act(async () => { late.resolve(ok(requestId, THREE)); });
    expect(screen.queryAllByTestId("structural-search-match")).toHaveLength(0);
    expect(screen.getByTestId("structural-search-panel")).toHaveAttribute("data-phase", "cancelled");
    expect(screen.getByTestId("structural-search-cancelled")).toHaveTextContent("Search cancelled");
    await waitFor(() => expect(screen.getByTestId("structural-search-panel")).toHaveAttribute("data-active-requests", "0"));
  });

  it("releases a running request when the workspace unmounts", async () => {
    const late = deferred<StructuralSearchResponse>();
    ipc.structuralSearchRun.mockImplementationOnce(() => late.promise);
    const view = render(<Harness />);
    await openDialog();
    fireEvent.keyDown(screen.getByTestId("structural-search-dialog"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(ipc.structuralSearchRun).toHaveBeenCalledTimes(1));
    const { requestId } = lastRequest();
    view.unmount();
    expect(ipc.structuralSearchCancel).toHaveBeenCalledWith(requestId);
    await act(async () => { late.resolve(ok(requestId, THREE)); });
  });
});
