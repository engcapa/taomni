import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SftpDetachedWindow, writeDetachedHandoff } from "./SftpDetachedWindow";
import { useSftpStore } from "../../stores/sftpStore";
import { broadcastReattach } from "../../lib/detachedSession";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";

vi.mock("./FileBrowser", () => ({ FileBrowser: () => <div data-testid="sftp-browser" /> }));
vi.mock("../../lib/runtime", () => ({ getAppPlatform: () => "windows", isTauriRuntime: () => true }));
vi.mock("../../lib/detachWindowing", () => ({ closeCurrentDetachedWindow: vi.fn(async () => {}) }));
vi.mock("../../lib/detachedSession", async () => ({
  ...await vi.importActual<typeof import("../../lib/detachedSession")>("../../lib/detachedSession"),
  broadcastReattach: vi.fn(),
}));
const params = {
  sessionId: "attached-source__detached", parentSessionId: "attached-source",
  host: "example.test", port: 22, username: "qa", authMethod: "Password", authData: "test",
  attachedToTerminal: true,
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useSftpStore.setState({ sessions: {} });
  writeDetachedHandoff(params);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("returns current directories once and releases only the popup's SFTP channel before closing", async () => {
  const state = useSftpStore.getState();
  const session = state.ensureSession(params.sessionId);
  useSftpStore.setState({ sessions: { [params.sessionId]: {
    ...session, remote: { ...session.remote, path: "/remote/chosen" }, local: { ...session.local, path: "/local/chosen" },
  } } });
  const detach = vi.spyOn(useSftpStore.getState(), "detach").mockResolvedValue();
  render(<SftpDetachedWindow sessionId={params.sessionId} />);
  fireEvent.click(screen.getByTestId("sftp-reattach"));
  fireEvent.click(screen.getByTestId("sftp-reattach"));
  await waitFor(() => expect(closeCurrentDetachedWindow).toHaveBeenCalledOnce());
  expect(broadcastReattach).toHaveBeenCalledExactlyOnceWith("sftp", params.sessionId, {
    ...params, initialPath: "/remote/chosen", initialLocalPath: "/local/chosen",
  });
  expect(detach).toHaveBeenCalledExactlyOnceWith(params.sessionId);
  expect(localStorage.getItem(`taomni.sftp.detached.${params.sessionId}`)).toBeNull();
});

it("shows a close failure and allows retrying the restore action", async () => {
  vi.spyOn(useSftpStore.getState(), "detach").mockResolvedValue();
  vi.mocked(closeCurrentDetachedWindow).mockRejectedValueOnce(new Error("window busy"));
  render(<SftpDetachedWindow sessionId={params.sessionId} />);
  fireEvent.click(screen.getByTestId("sftp-reattach"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("window busy"));
  fireEvent.click(screen.getByTestId("sftp-reattach"));
  await waitFor(() => expect(closeCurrentDetachedWindow).toHaveBeenCalledTimes(2));
});
