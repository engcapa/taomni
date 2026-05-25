import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ribbon } from "./Ribbon";

describe("Ribbon", () => {
  afterEach(() => {
    cleanup();
  });

  it("omits inactive Games and the duplicate middle Sessions command", () => {
    render(<Ribbon xServerEnabled={false} onCommand={vi.fn()} />);

    expect(screen.queryByTestId("ribbon-games")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ribbon-sessions")).not.toBeInTheDocument();
    expect(screen.getByTestId("ribbon-session")).toBeInTheDocument();
  });
});
