/**
 * FloatingToolbar tests focused on the new edge-dock + drawer-pull
 * affordance. We seed `localStorage` with a docked state so the toolbar
 * mounts directly into its drawer-pull form, then assert clicking the
 * tab restores the full toolbar.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingToolbar } from "./FloatingToolbar";

describe("FloatingToolbar edge-dock", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders the full toolbar when no state is stored", () => {
    render(
      <FloatingToolbar storageKey="test.no-stored" testId="tb-empty">
        <span data-testid="payload-empty">payload</span>
      </FloatingToolbar>,
    );
    expect(screen.getByTestId("tb-empty")).toBeInTheDocument();
    expect(screen.getByTestId("payload-empty")).toBeInTheDocument();
  });

  it("renders as a drawer-pull when collapsed=true with dockEdge='right'", async () => {
    localStorage.setItem(
      "test.docked",
      JSON.stringify({ top: 4, right: 4, collapsed: true, dockEdge: "right" }),
    );
    render(
      <FloatingToolbar storageKey="test.docked" testId="tb-docked">
        <span data-testid="payload-docked">payload</span>
      </FloatingToolbar>,
    );
    // Drawer-pull replaces the full toolbar; the payload should not be
    // visible until the user clicks the tab.
    expect(screen.queryByTestId("payload-docked")).toBeNull();
    const tab = screen.getByTestId("tb-docked");
    expect(tab).toBeInTheDocument();
    // Click the docked tab → toolbar restores in-place.
    await userEvent.click(tab);
    expect(screen.getByTestId("payload-docked")).toBeInTheDocument();
  });

  it("falls back to the legacy collapsed pill when no dockEdge is stored", () => {
    localStorage.setItem(
      "test.legacy-collapsed",
      JSON.stringify({ top: 4, right: 4, collapsed: true }),
    );
    render(
      <FloatingToolbar storageKey="test.legacy-collapsed" testId="tb-legacy">
        <span data-testid="payload-legacy">payload</span>
      </FloatingToolbar>,
    );
    // Legacy collapsed mode hides the payload but DOES render the
    // drag-handle + restore-pill pair, not a single docked sliver.
    expect(screen.queryByTestId("payload-legacy")).toBeNull();
    expect(screen.getByTestId("tb-legacy")).toBeInTheDocument();
  });

  it("ignores invalid dockEdge values", () => {
    localStorage.setItem(
      "test.bad-edge",
      JSON.stringify({ top: 4, right: 4, collapsed: false, dockEdge: "diagonal" }),
    );
    render(
      <FloatingToolbar storageKey="test.bad-edge" testId="tb-bad">
        <span data-testid="payload-bad">payload</span>
      </FloatingToolbar>,
    );
    // Bad edge → falls back to the full floating toolbar.
    expect(screen.getByTestId("payload-bad")).toBeInTheDocument();
  });
});
