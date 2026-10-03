import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShellSurfaceRegistry, StableSurface, SurfaceSlot } from "./SurfaceSlot";

describe("Stable business surface", () => {
  it("keeps the new host registered when an old host with the same identity leaves", () => {
    function Stage({ bottom }: { bottom: boolean }) { return <ShellSurfaceRegistry><div>{bottom && <SurfaceSlot id="panel:files" />}</div><div>{!bottom && <SurfaceSlot id="panel:files" />}</div><StableSurface id="files" slot="panel:files" visible><input aria-label="moved draft" defaultValue="initial" /></StableSurface></ShellSurfaceRegistry>; }
    const view = render(<Stage bottom={false} />);
    const input = screen.getByLabelText("moved draft");
    fireEvent.change(input, { target: { value: "retained" } });
    view.rerender(<Stage bottom />);
    expect(screen.getByLabelText("moved draft")).toBe(input);
    expect(input).toHaveValue("retained");
    expect(input.closest('[data-slot-id="panel:files"]')).toBeInTheDocument();
  });
  it("keeps one controller and its DOM draft when hidden and moved", () => {
    const mounted = vi.fn();
    function Business() { useState(() => { mounted(); return null; }); return <input aria-label="draft" defaultValue="initial" />; }
    function Stage({ slot, visible }: { slot: string; visible: boolean }) { return <ShellSurfaceRegistry><SurfaceSlot id="right" /><SurfaceSlot id="bottom" /><StableSurface id="files" slot={slot} visible={visible}><Business /></StableSurface></ShellSurfaceRegistry>; }
    const view = render(<Stage slot="right" visible />);
    const input = screen.getByLabelText("draft"); fireEvent.change(input, { target: { value: "retained draft" } });
    view.rerender(<Stage slot="right" visible={false} />); expect(input.closest('[data-surface-id="files"]')).toHaveAttribute("aria-hidden", "true");
    view.rerender(<Stage slot="bottom" visible />); expect(screen.getByLabelText("draft")).toBe(input); expect(input).toHaveValue("retained draft");
    expect(input.closest('[data-slot-id="bottom"]')).not.toBeNull(); expect(mounted).toHaveBeenCalledTimes(1);
  });
});
