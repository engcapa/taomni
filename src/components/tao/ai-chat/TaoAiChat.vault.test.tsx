import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { useVaultStore } from "../../../stores/vaultStore";
import { createChatController } from "./controller";
import { TaoAiChat } from "./TaoAiChat";
import type { ChatBackend, ChatProfile, TaoEvent } from "./ports";

const vault = vi.hoisted(() => ({ ready: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../lib/vaultGate", () => ({ useVaultGate: () => vault.ready }));

const initialVault = useVaultStore.getState();
const profile: ChatProfile = { modes: [{ id: "ask", label: "Ask" }], sidePanels: [], defaultModel: "deepseek-flash", defaultThinking: false, defaultWeb: false };

async function lockedChat(partial = true) {
  const backend: ChatBackend = {
    send: vi.fn(async () => [
      { type: "message_start" },
      ...(partial ? [
        { type: "block_start", index: 0, block: { type: "text" } },
        { type: "block_delta", index: 0, delta: { text: "Preserved answer" } },
      ] : []),
      { type: "error", category: "vault_locked", message: "request cancelled" },
      { type: "message_stop" },
    ] as TaoEvent[]),
    continue: vi.fn(async () => []), regenerate: vi.fn(async () => []),
  };
  const controller = createChatController({ backend });
  await controller.send("Slow response");
  controller.setComposerText("Preserved draft");
  render(<TaoAiChat controller={controller} profile={profile} />);
  return { controller, backend };
}

describe("Tao Vault recovery UI", () => {
  beforeEach(() => {
    setLocale("en");
    vault.ready.mockReset().mockResolvedValue(false);
    vault.refresh.mockReset().mockResolvedValue(undefined);
    useVaultStore.setState({ state: "locked", refresh: vault.refresh });
  });
  afterEach(() => { cleanup(); useVaultStore.setState(initialVault); });

  it("retains the mask, draft and focus when unlock is cancelled", async () => {
    const { backend } = await lockedChat();
    expect(screen.getByTestId("tao-home-composer-input")).toBeDisabled();
    expect(screen.queryByTestId("tao-home-error-state")).not.toBeInTheDocument();
    const unlock = screen.getByTestId("tao-home-vault-unlock");
    fireEvent.click(unlock);
    await waitFor(() => expect(vault.ready).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unlock).toBeEnabled());
    expect(vault.refresh.mock.invocationCallOrder[0]).toBeLessThan(vault.ready.mock.invocationCallOrder[0]);
    expect(unlock).toHaveFocus();
    expect(screen.getByTestId("tao-home-vault-locked")).toBeVisible();
    expect(screen.getByTestId("tao-home-composer-input")).toHaveValue("Preserved draft");
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(backend.continue).not.toHaveBeenCalled();
    expect(backend.regenerate).not.toHaveBeenCalled();
  });

  it("unlocks without paying for a request and focuses explicit Continue", async () => {
    vault.ready.mockResolvedValue(true);
    const { backend } = await lockedChat();
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    const proceed = await screen.findByTestId("tao-home-continue");
    expect(proceed).toHaveFocus();
    expect(screen.queryByTestId("tao-home-vault-locked")).not.toBeInTheDocument();
    expect(screen.getByText("Preserved answer")).toBeInTheDocument();
    expect(screen.getByTestId("tao-home-composer-input")).toHaveValue("Preserved draft");
    expect(backend.continue).not.toHaveBeenCalled();
    expect(backend.regenerate).not.toHaveBeenCalled();
    fireEvent.click(proceed);
    await waitFor(() => expect(backend.continue).toHaveBeenCalledTimes(1));
  });

  it("dismisses the mask while retaining the locked thread and explicit unlock entry", async () => {
    const { controller, backend } = await lockedChat();
    const threadId = controller.getState().activeThreadId!;
    fireEvent.click(screen.getByTestId("tao-home-vault-dismiss"));
    expect(screen.queryByTestId("tao-home-vault-locked")).not.toBeInTheDocument();
    expect(screen.getByTestId("tao-home-vault-notice")).toBeVisible();
    expect(screen.getByText("Preserved answer")).toBeInTheDocument();
    expect(controller.getState().runtime[threadId].phase).toBe("vault_locked");
    expect(controller.getState().composer.text).toBe("Preserved draft");
    expect(await controller.send()).toBe(false);
    expect(await controller.continueReply()).toBe(false);
    expect(await controller.regenerate()).toBe(false);
    act(() => { controller.createThread("Unblocked Home"); controller.setActiveThread(threadId); });
    expect(screen.queryByTestId("tao-home-vault-locked")).not.toBeInTheDocument();
    expect(screen.getByTestId("tao-home-vault-unlock")).toBeEnabled();
    vault.ready.mockResolvedValue(true);
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    expect(await screen.findByTestId("tao-home-continue")).toBeEnabled();
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(backend.continue).not.toHaveBeenCalled();
    expect(backend.regenerate).not.toHaveBeenCalled();
  });

  it("shows refresh errors and allows another explicit unlock attempt", async () => {
    vault.refresh.mockRejectedValueOnce(new Error("status unavailable"));
    await lockedChat();
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not unlock Vault: Error: status unavailable");
    expect(vault.ready).not.toHaveBeenCalled();
    vault.ready.mockResolvedValue(true);
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    expect(await screen.findByTestId("tao-home-continue")).toBeEnabled();
  });

  it("offers Regenerate when locking happened before any content arrived", async () => {
    vault.ready.mockResolvedValue(true);
    const { backend } = await lockedChat(false);
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    const regenerate = await screen.findByTestId("tao-home-regenerate");
    expect(screen.getByTestId("tao-home-stopped-state")).toHaveTextContent("No reply was received");
    expect(backend.regenerate).not.toHaveBeenCalled();
    fireEvent.click(regenerate);
    await waitFor(() => expect(backend.regenerate).toHaveBeenCalledTimes(1));
  });

  it("applies a delayed unlock to its original thread", async () => {
    let unlock!: (ready: boolean) => void;
    vault.ready.mockImplementation(() => new Promise<boolean>((resolve) => { unlock = resolve; }));
    const { controller } = await lockedChat();
    const locked = controller.getState().activeThreadId!;
    fireEvent.click(screen.getByTestId("tao-home-vault-unlock"));
    await waitFor(() => expect(vault.ready).toHaveBeenCalled());
    let other!: string;
    act(() => { other = controller.createThread("Other chat"); controller.setComposerText("Other draft"); });
    await act(async () => { unlock(true); });
    expect(controller.getState().runtime[locked].phase).toBe("stopped");
    expect(controller.getState().activeThreadId).toBe(other);
    expect(screen.getByTestId("tao-home-composer-input")).toHaveValue("Other draft");
  });
});
