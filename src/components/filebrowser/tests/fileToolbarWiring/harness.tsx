import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import type { FileEntry } from "../../../../lib/sftp";
import { useSftpStore, type PaneState } from "../../../../stores/sftpStore";
import { FilePanel } from "../../FilePanel";

const controllerMocks = vi.hoisted(() => ({
  upload: vi.fn(async () => undefined),
  uploadBlob: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  chmodRecursive: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  createFile: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
}));

const sftpMocks = vi.hoisted(() => ({
  sftpStat: vi.fn(async (_sessionId: string, path: string): Promise<FileEntry> => ({
    name: path.replace(/\\/g, "/").split("/").pop() || "file",
    path,
    size: 12,
    mtime: 1_700_000_000,
    mode: 0o644,
    fileType: "file",
    isHidden: false,
  })),
  sftpOpenPath: vi.fn(async () => undefined),
}));

vi.mock("../../../../lib/sftpController", () => ({
  useSftpController: () => controllerMocks,
}));

vi.mock("../../../../lib/sftp", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/sftp")>("../../../../lib/sftp");
  return {
    ...actual,
    sftpListRemote: vi.fn(async () => []),
    sftpListLocal: vi.fn(async () => []),
    sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
    sftpLocalHome: vi.fn(async () => "/home/test"),
    sftpAttach: vi.fn(async () => undefined),
    sftpDetach: vi.fn(async () => undefined),
    sftpRealpath: vi.fn(async (_sid: string, p: string) => p),
    sftpStat: sftpMocks.sftpStat,
    sftpOpenPath: sftpMocks.sftpOpenPath,
  };
});

export const SESSION_ID = "test-session";

export function file(name: string, opts: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: opts.path ?? `/work/${name}`,
    size: 100,
    mtime: 1_700_000_000,
    mode: 0o644,
    fileType: "file",
    isHidden: name.startsWith("."),
    ...opts,
  };
}

export function dir(name: string, opts: Partial<FileEntry> = {}): FileEntry {
  return file(name, { ...opts, fileType: "dir", size: 0 });
}

export function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    path: "/work",
    entries: [
      dir("subdir"),
      file("notes.txt"),
      file("image.png"),
      file(".hidden"),
    ],
    selection: [],
    loading: false,
    error: null,
    skippedEntryCount: 0,
    entryDiagnostics: [],
    history: ["/work"],
    historyIndex: 0,
    showHidden: false,
    ...overrides,
  };
}

export function seedSession(extra: Partial<PaneState> = {}) {
  useSftpStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [SESSION_ID]: {
        sessionId: SESSION_ID,
        attached: true,
        attaching: false,
        homeDir: "/home/test",
        error: null,
        local: makePane(extra),
        remote: makePane(extra),
      },
    },
  }));
}

export function setSelection(side: "local" | "remote", paths: string[]) {
  act(() => {
    useSftpStore.getState().setSelection(SESSION_ID, side, paths);
  });
}

export const noopHandlers = {
  onItemDoubleClick: vi.fn(),
  onEmptyContext: vi.fn(() => []),
};

export function renderRemote(extra: Record<string, unknown> = {}) {
  return render(
    <FilePanel
      sessionId={SESSION_ID}
      side="remote"
      subtitle="user@example.com"
      onDownloadSelected={vi.fn()}
      onUploadFromDisk={vi.fn()}
      onDeleteSelected={vi.fn()}
      onChmodSelected={vi.fn()}
      onPreviewSelected={vi.fn()}
      onOpenTerminalHere={vi.fn()}
      {...noopHandlers}
      {...extra}
    />,
  );
}

export function renderLocal(extra: Record<string, unknown> = {}) {
  return render(
    <FilePanel
      sessionId={SESSION_ID}
      side="local"
      onUploadSelected={vi.fn()}
      onDeleteSelected={vi.fn()}
      onChmodSelected={vi.fn()}
      onPreviewSelected={vi.fn()}
      {...noopHandlers}
      {...extra}
    />,
  );
}

export { controllerMocks, sftpMocks };
