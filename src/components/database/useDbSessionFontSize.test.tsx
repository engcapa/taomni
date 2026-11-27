import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { useDbSessionFontSize } from "./useDbSessionFontSize";

function Harness({ visible = true }: { visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { fontSize } = useDbSessionFontSize(visible, ref);
  return (
    <div ref={ref} data-testid="db-font-root">
      {fontSize}
    </div>
  );
}

describe("useDbSessionFontSize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses terminal-style shortcuts for DB session font size", () => {
    render(<Harness />);

    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");

    fireEvent.keyDown(screen.getByTestId("db-font-root"), { key: "+", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("14");
    expect(localStorage.getItem("taomni.db.sessionFontSize.v1")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("db-font-root"), { key: "-", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");

    fireEvent.keyDown(screen.getByTestId("db-font-root"), { key: "+", ctrlKey: true });
    fireEvent.keyDown(screen.getByTestId("db-font-root"), { key: "0", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");
  });

  it("zooms only the addressed session and resets to its saved base", () => {
    localStorage.setItem("taomni.db.sessionFontSize.v1", "17");
    render(<><Harness /><Harness /></>);
    const [first, second] = screen.getAllByTestId("db-font-root");
    fireEvent.keyDown(first, { key: "=", ctrlKey: true });
    fireEvent.keyDown(second, { key: "-", ctrlKey: true });
    expect(first).toHaveTextContent("18");
    expect(second).toHaveTextContent("16");
    fireEvent.keyDown(document.body, { key: "=", ctrlKey: true });
    fireEvent.keyDown(second, { key: "0", ctrlKey: true });
    expect(second).toHaveTextContent("17");
    expect(first).toHaveTextContent("18");
    expect(localStorage.getItem("taomni.db.sessionFontSize.v1")).toBe("17");
  });

  it("ignores shortcuts while the DB tab is hidden", () => {
    render(<Harness visible={false} />);

    fireEvent.keyDown(screen.getByTestId("db-font-root"), { key: "+", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");
  });
});
