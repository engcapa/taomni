import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Tab } from "../../../types";
import { TabIcon } from "./TabItem";

afterEach(cleanup);

describe("Explorer tab icon", () => {
  it.each([true, undefined] as const)("shows the prototype's yellow folder for Explorer and legacy File tabs (%s)", (explorer) => {
    const tab: Tab = {
      id: "files", title: "Files", type: "file-browser", closable: true,
      fileBrowser: { initialPath: "/files", explorer },
    };
    const { container } = render(<TabIcon tab={tab} />);
    expect(container.querySelector("svg")).toHaveClass("taomni-explorer-tab-icon", "h-3.5", "w-3.5");
    expect(container.querySelector("svg path")).toHaveAttribute("fill", "var(--ex-folder)");
    expect(container.querySelectorAll("svg path")).toHaveLength(2);
  });

  it("uses the themed accent for the SFTP folder", () => {
    const tab: Tab = { id: "sftp", title: "SFTP", type: "sftp", closable: true };
    const { container } = render(<TabIcon tab={tab} />);
    expect(container.querySelector("svg")).toHaveClass("lucide-folder");
    expect(container.querySelector("svg")).toHaveStyle({ color: "var(--taomni-accent)" });
    expect(container.querySelector("svg")).toHaveAttribute("fill", "none");
  });
});
