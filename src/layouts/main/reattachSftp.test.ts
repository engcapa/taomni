import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reattachSftp, type SftpReattachContext } from "./reattachSftp";
import { useSftpStore } from "../../stores/sftpStore";
import { useAppStore } from "../../stores/appStore";
import type { DetachedSftpParams } from "../../lib/sftpWindowState";
import type { Tab } from "../../types";

const params: DetachedSftpParams = {
  sessionId: "attached-ssh-1__detached", parentSessionId: "attached-ssh-1",
  host: "example.test", port: 22, username: "qa", authMethod: "Password", authData: "test",
  attachedToTerminal: true, initialPath: "/remote/current", initialLocalPath: "/local/current",
};

function setup(tabs: Tab[]): SftpReattachContext {
  const tabsRef = { current: tabs };
  return {
    tabsRef, setActiveTab: vi.fn(), showAttachedSftp: vi.fn(),
    addTab: vi.fn((tab: Tab) => { tabsRef.current.push(tab); }),
  };
}

beforeEach(() => { useSftpStore.setState({ sessions: {} }); });
afterEach(() => vi.restoreAllMocks());

it("restores the source sidebar and both directories without creating or restarting a terminal", async () => {
  const source: Tab = { id: "ssh-1", title: "SSH", type: "terminal", closable: true, ssh: params };
  const context = setup([source]);
  useAppStore.setState({ terminalSplitActive: true, activeSideTab: "home" });
  const session = useSftpStore.getState().ensureSession(params.parentSessionId!);
  useSftpStore.setState({ sessions: { [session.sessionId]: { ...session, attached: true } } });
  const navigate = vi.spyOn(useSftpStore.getState(), "navigate").mockResolvedValue();
  expect(await reattachSftp(params, context)).toBe(true);
  expect(context.setActiveTab).toHaveBeenCalledWith("ssh-1");
  expect(context.showAttachedSftp).toHaveBeenCalledWith("ssh-1");
  expect(context.addTab).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith("attached-ssh-1", "remote", "/remote/current");
  expect(navigate).toHaveBeenCalledWith("attached-ssh-1", "local", "/local/current");
  expect(useAppStore.getState()).toMatchObject({ terminalSplitActive: false, activeSideTab: "sessions" });
});

it("returns a standalone SFTP popup to its existing tab", async () => {
  const context = setup([{ id: "files", title: "Files", type: "sftp", closable: true,
    sftp: { ...params, sessionId: "source-files" } }]);
  await reattachSftp({ ...params, parentSessionId: "source-files", attachedToTerminal: false }, context);
  expect(context.setActiveTab).toHaveBeenCalledWith("files");
  expect(context.showAttachedSftp).not.toHaveBeenCalled();
  expect(context.addTab).not.toHaveBeenCalled();
});

it("recovers as a single file tab when the originating terminal was closed", async () => {
  const context = setup([]);
  await reattachSftp(params, context);
  await reattachSftp(params, context);
  expect(context.addTab).toHaveBeenCalledOnce();
  expect(context.tabsRef.current[0]).toMatchObject({
    type: "sftp", sftp: { sessionId: "attached-ssh-1", initialPath: "/remote/current", initialLocalPath: "/local/current" },
  });
  expect(context.showAttachedSftp).not.toHaveBeenCalled();
});
