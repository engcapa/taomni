import { act, cleanup, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useCodeWorkspaceStatusStore } from "../../../../stores/codeWorkspaceStatusStore";
import { Breadcrumbs } from "../Breadcrumbs";
import { useEditorGroupBreadcrumbs } from "./useEditorGroupBreadcrumbs";

function Group({ active = true, visible = true, owner = "primary" }) {
  const navigation = useEditorGroupBreadcrumbs({
    placement: "status-bar", active, visible, ownerId: owner,
    content: (variant) => <Breadcrumbs variant={variant} symbols={[]} position={{ line: 0, character: 0 }}
      pathSegments={[{ kind: "file", label: `${owner}.md`, path: `${owner}.md` }]} />,
  });
  return <div data-testid={`group-${owner}`}>{navigation.statusBarNavigation
    ? createPortal(navigation.breadcrumbs, navigation.statusBarNavigation)
    : navigation.breadcrumbs}</div>;
}

afterEach(() => {
  cleanup();
  useCodeWorkspaceStatusStore.setState({ navigationHost: null, navigationPortalOwner: null });
});

describe("editor group breadcrumb portal geometry", () => {
  it("uses a fixed bar in inactive splits and a status variant only in the actual host", () => {
    const host = document.createElement("div");
    document.body.append(host);
    act(() => useCodeWorkspaceStatusStore.getState().setNavigationHost(host));
    const view = render(<><Group owner="primary" /><Group active={false} owner="secondary" /></>);
    expect(host.querySelector("nav")).toHaveAttribute("data-variant", "statusbar");
    const secondary = screen.getByTestId("group-secondary").querySelector("nav");
    expect(secondary).toHaveAttribute("data-variant", "bar");
    expect(secondary).toHaveClass("h-7", "shrink-0");
    expect(secondary).not.toHaveClass("h-full", "flex-1");
    expect(useCodeWorkspaceStatusStore.getState().navigationPortalOwner).toBe("primary");
    view.rerender(<><Group active={false} owner="primary" /><Group owner="secondary" /></>);
    expect(host).toHaveTextContent("secondary.md");
    expect(screen.getByTestId("group-primary").querySelector("nav")).toHaveAttribute("data-variant", "bar");
    expect(useCodeWorkspaceStatusStore.getState().navigationPortalOwner).toBe("secondary");
    view.unmount();
    expect(useCodeWorkspaceStatusStore.getState().navigationPortalOwner).toBeNull();
    host.remove();
  });

  it("restores local bars when hidden or when the status host disappears", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = render(<Group />);
    expect(screen.getByTestId("group-primary").querySelector("nav")).toHaveAttribute("data-variant", "bar");
    act(() => useCodeWorkspaceStatusStore.getState().setNavigationHost(host));
    expect(host.querySelector("nav")).toHaveAttribute("data-variant", "statusbar");
    view.rerender(<Group visible={false} />);
    expect(host.querySelector("nav")).toBeNull();
    expect(screen.getByTestId("group-primary").querySelector("nav")).toHaveAttribute("data-variant", "bar");
    expect(useCodeWorkspaceStatusStore.getState().navigationPortalOwner).toBeNull();
    view.rerender(<Group />);
    act(() => useCodeWorkspaceStatusStore.getState().setNavigationHost(null));
    expect(screen.getByTestId("group-primary").querySelector("nav")).toHaveClass("h-7");
    host.remove();
  });
});
