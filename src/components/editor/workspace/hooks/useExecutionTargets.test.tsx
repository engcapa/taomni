import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceExecutionModel } from "../../../../lib/editor/workspace";
import { makeLoadingFile, type OpenFileState } from "../codeWorkspaceModel";
import { useExecutionTargets, type UseExecutionTargetsContext } from "./useExecutionTargets";

const ipc = vi.hoisted(() => ({ workspaceExecutionModel: vi.fn(), workspaceJavaRunTarget: vi.fn() }));
vi.mock("../../../../lib/editor/workspace", () => ipc);
const root = { id: "home", name: "Home", path: "/home/public", kind: "folder" as const };
const emptyModel: WorkspaceExecutionModel = {
  projects: [], buildTargets: [], runConfigurations: [], debugConfigurations: [], tools: [],
};

function harness() {
  const context: UseExecutionTargetsContext = {
    workspaceInstanceId: "execution-responsiveness", openFilesRef: { current: {} }, activeKey: null,
    findRoot: () => root,
    absolutePathForOpenFile: (file) => `${root.path}/${file.ref.path}`,
    toolConfigRef: { current: undefined }, toolConfig: undefined,
    activeFileIsJava: false, activeFile: null, roots: [root], setStatusMessage: vi.fn(),
  };
  const file = (path: string) => {
    const value: OpenFileState = {
      ...makeLoadingFile({ kind: "root", rootId: root.id, path }, [root], []), loading: false,
    };
    context.openFilesRef.current[value.key] = value;
    return value;
  };
  const files = ["notes.txt", "records.json", "page.html", "README.md", "src/main.go", "Cargo.toml"].map(file);
  const select = (selected: OpenFileState) => {
    context.activeKey = selected.key;
    context.activeFile = selected;
    return { ...context };
  };
  return { context, files, select };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.workspaceExecutionModel.mockResolvedValue(emptyModel);
});

it("opens and switches ordinary home documents without scanning execution projects", () => {
  const h = harness();
  const { result, rerender } = renderHook(useExecutionTargets, { initialProps: h.select(h.files[0]!) });
  for (const file of h.files.slice(1, 4)) rerender(h.select(file));
  expect(result.current.activeExecutionModel).toBeNull();
  expect(ipc.workspaceExecutionModel).not.toHaveBeenCalled();
  expect(ipc.workspaceJavaRunTarget).not.toHaveBeenCalled();
});

it("retains automatic discovery for sources and build descriptors", async () => {
  const h = harness();
  const { rerender } = renderHook(useExecutionTargets, { initialProps: h.select(h.files[4]!) });
  await waitFor(() => expect(ipc.workspaceExecutionModel).toHaveBeenCalledWith(root.path, `${root.path}/src/main.go`, undefined));
  rerender(h.select(h.files[5]!));
  await waitFor(() => expect(ipc.workspaceExecutionModel).toHaveBeenCalledWith(root.path, `${root.path}/Cargo.toml`, undefined));
});

it("retains project-level discovery when the active file is project documentation", async () => {
  const h = harness();
  h.context.projectDetected = true;
  const { result } = renderHook(useExecutionTargets, { initialProps: h.select(h.files[0]!) });
  await waitFor(() => expect(result.current.activeExecutionModel).toBe(emptyModel));
  expect(ipc.workspaceExecutionModel).toHaveBeenCalledExactlyOnceWith(root.path, `${root.path}/notes.txt`, undefined);
});

it("rejects a late source model after selecting an ordinary document", async () => {
  let finish!: (value: WorkspaceExecutionModel) => void;
  ipc.workspaceExecutionModel.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const h = harness();
  const { result, rerender } = renderHook(useExecutionTargets, { initialProps: h.select(h.files[4]!) });
  expect(ipc.workspaceExecutionModel).toHaveBeenCalledOnce();
  rerender(h.select(h.files[0]!));
  await act(async () => { finish(emptyModel); });
  expect(result.current.activeExecutionModel).toBeNull();
  expect(result.current.activeRunConfigurations).toEqual([]);
  expect(ipc.workspaceExecutionModel).toHaveBeenCalledOnce();
});
