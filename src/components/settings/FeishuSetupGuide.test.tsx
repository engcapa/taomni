import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { FeishuSetupGuide } from "./FeishuSetupGuide";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("../../lib/sftp", () => ({ openExternalUrl: openUrl }));
beforeEach(() => { setLocale("en"); openUrl.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.resetAllMocks(); setLocale("en"); });

it("opens an ordered setup path with a usable message payload and independent identity bootstrap", () => {
  render(<FeishuSetupGuide />);
  const toggle = screen.getByRole("button", { name: "Setup guide" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("feishu-guide")).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("feishu-guide")).toHaveAttribute("id", toggle.getAttribute("aria-controls"));
  const headings = within(screen.getByTestId("feishu-guide")).getAllByRole("heading", { level: 6 });
  expect(headings.map(heading => heading.textContent)).toEqual([
    "Create the app and copy its credentials", "Enable the bot and request permissions",
    "Publish and authorize the app", "Get the user's open_id",
    "Get the private chat_id and fill Authorized identities", "Save in Taomni and start the connection",
    "Configure event and card subscriptions while connected", "Verify commands and card buttons",
  ]);
  const payload = JSON.parse(screen.getByTestId("feishu-guide-message-example").textContent!);
  expect(payload).toEqual({ receive_id: "ou_REPLACE_WITH_USER_OPEN_ID", msg_type: "text", content: expect.any(String) });
  expect(JSON.parse(payload.content)).toEqual({ text: "Taomni setup test" });
  expect(screen.getByTestId("feishu-guide-step-chat")).toHaveTextContent("No Taomni connection or incoming event is needed");
  fireEvent.click(toggle);
  expect(screen.queryByTestId("feishu-guide")).not.toBeInTheDocument();
});

it("updates the open guide in place when the application language changes", () => {
  render(<FeishuSetupGuide />);
  fireEvent.click(screen.getByTestId("feishu-guide-toggle"));
  expect(screen.getByTestId("feishu-guide")).not.toHaveTextContent(/[一-鿿]/);
  act(() => setLocale("zh-CN"));
  expect(screen.getByRole("button", { name: "收起配置指南" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("heading", { name: "一步一步连接飞书机器人" })).toBeInTheDocument();
  expect(screen.getByTestId("feishu-guide-step-user")).toHaveTextContent("快速复制 open_id");
  expect(screen.getByTestId("feishu-guide-step-events")).toHaveTextContent("未检测到应用连接");
  expect(screen.getByTestId("feishu-guide")).not.toHaveTextContent("feishuSettings.guide.");
});

it("opens official references through the shared external URL boundary and reports launch failures", async () => {
  render(<FeishuSetupGuide />);
  fireEvent.click(screen.getByTestId("feishu-guide-toggle"));
  for (const link of screen.getAllByRole("link")) {
    fireEvent.click(link);
    expect(openUrl).toHaveBeenLastCalledWith(link.getAttribute("href"));
    expect(new URL(link.getAttribute("href")!).hostname).toBe("open.feishu.cn");
  }
  openUrl.mockRejectedValueOnce(new Error("browser launch failed"));
  fireEvent.click(screen.getByTestId("feishu-guide-console"));
  expect(await screen.findByRole("alert")).toHaveTextContent("browser launch failed");
  fireEvent.click(screen.getByTestId("feishu-guide-console"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
