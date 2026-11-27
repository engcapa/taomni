import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_VNC_VIEWER_OPTIONS } from "../../../../src/lib/vncOptions";
import { VncPropertiesDialog } from "./VncPropertiesDialog";

afterEach(cleanup);

it("keeps the connection draft, recognizes a reverted value and separates apply from reconnect", () => {
  const onClose = vi.fn();
  const onApply = vi.fn();
  const initial = { viewer: DEFAULT_VNC_VIEWER_OPTIONS, viewOnly: false, clipboardPolicy: "bidirectional" as const };
  render(<VncPropertiesDialog initial={initial} onClose={onClose} onApply={onApply} returnFocus={null} />);
  const quality = screen.getByTestId("vnc-prop-quality");
  expect(quality).toHaveFocus();
  fireEvent.change(quality, { target: { value: "low" } });
  fireEvent.keyDown(quality, { key: "Escape" });
  expect(screen.getByTestId("confirm-dialog-cancel")).toHaveFocus();
  fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
  expect(quality).toHaveValue("low");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(quality, { target: { value: "automatic" } });
  fireEvent.click(screen.getByTestId("vnc-prop-cancel"));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  fireEvent.click(screen.getByTestId("vnc-prop-view-only"));
  fireEvent.click(screen.getByTestId("vnc-prop-ok"));
  expect(onApply).toHaveBeenLastCalledWith({ ...initial, viewOnly: true }, false);
  fireEvent.click(screen.getByTestId("vnc-prop-ok-reconnect"));
  expect(onApply).toHaveBeenLastCalledWith({ ...initial, viewOnly: true }, true);
});
