import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlockToolbar } from "./CodeBlockToolbar";
import { useAppStore } from "../../stores/appStore";
import { registerTerminal } from "../../lib/terminal/terminalRegistry";

const terminalCleanups: Array<() => void> = [];

describe("CodeBlockToolbar selection UI", () => {
  afterEach(() => {
    for (const cleanupTerminal of terminalCleanups.splice(0)) {
      cleanupTerminal();
    }
    cleanup();
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
    });
  });

  it("starts line selection unchecked and omits selectors for comments and blanks", async () => {
    const user = userEvent.setup();
    render(
      <CodeBlockToolbar
        code={"# show network sockets\nss -tlnp\n\n# inspect process files\nlsof -p 1234"}
        lang="bash"
      />,
    );

    await user.click(screen.getByRole("button", { name: /选行/ }));

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes) {
      expect(checkbox).not.toBeChecked();
    }
    expect(screen.getByText("# show network sockets").closest("label")).toBeNull();
    expect(screen.getByText("# inspect process files").closest("label")).toBeNull();
  });

  it("sends a single line to the terminal without appending enter", async () => {
    const user = userEvent.setup();
    const writeInput = vi.fn();
    terminalCleanups.push(registerTerminal({
      tabId: "term-1",
      sessionId: "session-1",
      title: "Terminal 1",
      getBufferText: () => "",
      getLastLines: () => "",
      writeInput,
    }));
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
    });

    render(<CodeBlockToolbar code="ss -tlnp" lang="bash" />);

    await user.click(screen.getByRole("button", { name: /发送到终端/ }));

    expect(writeInput).toHaveBeenCalledWith("ss -tlnp");
  });

  it("requires confirmation before sending multiple lines", async () => {
    const user = userEvent.setup();
    const writeInput = vi.fn();
    terminalCleanups.push(registerTerminal({
      tabId: "term-1",
      sessionId: "session-1",
      title: "Terminal 1",
      getBufferText: () => "",
      getLastLines: () => "",
      writeInput,
    }));
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
    });

    render(<CodeBlockToolbar code={"ss -tlnp\nlsof -i :8080"} lang="bash" />);

    await user.click(screen.getByRole("button", { name: /发送到终端/ }));

    expect(writeInput).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认发送多行内容" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^发送$/ }));

    expect(writeInput).toHaveBeenCalledWith("ss -tlnp\rlsof -i :8080");
  });
});
