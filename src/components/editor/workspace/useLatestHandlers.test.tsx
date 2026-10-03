import { memo, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatestHandlers } from "./useLatestHandlers";
import { KeepAliveToolPanel } from "./panels/BottomDock";

describe("useLatestHandlers", () => {
  it("keeps handler identity stable and calls the latest closure", () => {
    let childRenders = 0;
    const Child = memo(function Child({ onPick }: { onPick: () => void }) {
      childRenders += 1;
      return <button type="button" onClick={onPick}>pick</button>;
    });
    const picked: number[] = [];
    function Parent() {
      const [count, setCount] = useState(0);
      const handlers = useLatestHandlers({ onPick: () => picked.push(count) });
      return (
        <>
          <button type="button" onClick={() => setCount((value) => value + 1)}>bump</button>
          <Child {...handlers} />
        </>
      );
    }
    render(<Parent />);
    expect(childRenders).toBe(1);
    fireEvent.click(screen.getByText("bump"));
    fireEvent.click(screen.getByText("bump"));
    // The memoized child did not re-render for parent-only state changes…
    expect(childRenders).toBe(1);
    fireEvent.click(screen.getByText("pick"));
    // …and its stable handler still saw the latest parent state.
    expect(picked).toEqual([2]);
  });
});

describe("KeepAliveToolPanel", () => {
  it("skips re-rendering hidden panels and catches up when shown", () => {
    let panelRenders = 0;
    function Panel({ value }: { value: number }) {
      panelRenders += 1;
      return <span data-testid="panel-value">{value}</span>;
    }
    function Host({ active, value }: { active: boolean; value: number }) {
      return <KeepAliveToolPanel active={active}><Panel value={value} /></KeepAliveToolPanel>;
    }
    const view = render(<Host active={false} value={1} />);
    expect(panelRenders).toBe(1);
    view.rerender(<Host active={false} value={2} />);
    view.rerender(<Host active={false} value={3} />);
    expect(panelRenders).toBe(1);
    expect(screen.getByTestId("panel-value").textContent).toBe("1");
    act(() => {
      view.rerender(<Host active value={4} />);
    });
    expect(panelRenders).toBe(2);
    expect(screen.getByTestId("panel-value").textContent).toBe("4");
    view.rerender(<Host active value={5} />);
    expect(screen.getByTestId("panel-value").textContent).toBe("5");
  });
});
