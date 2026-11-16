import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { useTaoText } from "../i18n";
import { createChatController } from "./controller";
import { WorkflowPanel } from "./WorkflowPanel";

vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./nativeCapabilities", () => ({ nativeCapabilities: {
  listWorkflows: async () => [
    { id: "code_review", title: "代码 review" }, { id: "sql_investigate", title: "SQL 排查" },
    { id: "user-defined", title: "文件整理" },
  ], listRuns: async () => [],
} }));

afterEach(() => { cleanup(); setLocale("en"); });

it("localizes built-in workflow names by identity and preserves user-defined titles", async () => {
  const controller = createChatController();
  function Panel() { useTaoText(); return <WorkflowPanel controller={controller} />; }
  render(<Panel />);
  expect(await screen.findByText("Code review")).toBeInTheDocument();
  expect(screen.getByText("SQL investigation")).toBeInTheDocument();
  expect(screen.getByText("文件整理")).toBeInTheDocument();
  act(() => setLocale("zh-CN"));
  expect(screen.getByText("代码 review")).toBeInTheDocument();
  expect(screen.getByText("SQL 排查")).toBeInTheDocument();
});
