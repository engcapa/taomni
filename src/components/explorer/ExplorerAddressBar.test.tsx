import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerAddressBar } from "./ExplorerAddressBar";
import { emptyPane } from "../../stores/sftp/listing";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Explorer long address breadcrumb visibility", () => {
  it("scrolls the actual last button, not a display-contents wrapper, into the viewport", () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    const path = "/very/long/native/report/profile/path/source/folder/nested";
    render(<ExplorerAddressBar tabId="address" pane={{ ...emptyPane(), path }} home="/home" filter="" onFilter={vi.fn()} addressRef={createRef()} />);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "end" });
    const last = screen.getAllByTestId("explorer-crumb").at(-1)!;
    expect(last).toHaveClass("last");
    expect(last).toHaveAttribute("data-path", path);
    expect(scroll.mock.instances.at(-1)).toBe(last);
    expect(last.parentElement).not.toHaveClass("contents");
  });
});
