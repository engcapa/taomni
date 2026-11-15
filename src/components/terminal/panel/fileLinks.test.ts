import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFile } from "../../../lib/openFile";
import { sftpStat } from "../../../lib/sftp";
import { installTerminalFileLinks } from "./fileLinks";
import type { TerminalSessionLifecycleContext } from "./sessionContracts";

vi.mock("../../../lib/openFile", () => ({ openFile: vi.fn(async () => "viewer") }));
vi.mock("../../../lib/sftp", () => ({ sftpStat: vi.fn(async () => ({ fileType: "file" })), effectiveFileType: (entry: { fileType: string }) => entry.fileType }));
vi.mock("../../../lib/runtime", () => ({ getAppPlatform: () => "linux" }));
vi.mock("../../../lib/fileOpenContext", () => ({ fileOpenWorkspaceForTab: () => "workspace" }));

function setup(local = true, mac = false) {
  const text = "  /tmp/report.html:9";
  let provider!: ILinkProvider;
  const dispose = vi.fn();
  const terminal = {
    cols: 80,
    buffer: { active: { getLine: () => ({ translateToString: () => text, getCell: (column: number) => ({ getChars: () => text[column] || " ", getWidth: () => 1 }) }) } },
    registerLinkProvider: (value: ILinkProvider) => { provider = value; return { dispose }; },
  } as unknown as Terminal;
  const status = vi.fn();
  const context = { isMac: mac, isLocalRef: { current: local }, latestCwdRef: { current: "/tmp" }, tabId: "terminal", setStatusMessage: status } as unknown as TerminalSessionLifecycleContext;
  const registration = installTerminalFileLinks(terminal, context);
  let links!: ILink[];
  provider.provideLinks(1, (value) => { links = value!; });
  return { links, status, registration, dispose };
}

beforeEach(() => vi.clearAllMocks());
describe("terminal local file links", () => {
  it("requires the platform modifier, preserves line/workspace and disposes the provider", async () => {
    const { links, registration, dispose } = setup();
    expect(links[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 20, y: 1 } });
    links[0].activate(new MouseEvent("click"), links[0].text);
    expect(openFile).not.toHaveBeenCalled();
    links[0].activate(new MouseEvent("click", { ctrlKey: true }), links[0].text);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: "/tmp/report.html" }, { context: "terminal-link", workspaceId: "workspace", line: 9 }));
    registration.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("uses Command on macOS and never treats SSH output as a local file", async () => {
    const local = setup(true, true);
    local.links[0].activate(new MouseEvent("click", { ctrlKey: true }), local.links[0].text);
    expect(openFile).not.toHaveBeenCalled();
    const remote = setup(false, true);
    remote.links[0].activate(new MouseEvent("click", { metaKey: true }), remote.links[0].text);
    expect(remote.status).toHaveBeenCalled();
    expect(sftpStat).not.toHaveBeenCalled();
  });
});
