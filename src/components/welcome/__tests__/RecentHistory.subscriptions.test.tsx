import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "../../tests/welcomePanel/harness";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { RecentSessionsPanel } from "../RecentSessionsPanel";
import { RecentWorkspacesPanel } from "../RecentWorkspacesPanel";

afterEach(cleanup);

it("keeps recent histories out of unrelated application state updates", () => {
  const translateSessions = vi.fn((key: string) => key);
  const translateWorkspaces = vi.fn((key: string) => key);
  const action = vi.fn();
  render(<>
    <RecentSessionsPanel translate={translateSessions} sessions={[]} filteredSessions={[]}
      typeOptions={[]} query="" typeFilter="all" sort="last-desc"
      selectedIds={new Set()} selectedCount={0} selectedSessions={[]}
      onQueryChange={action} onTypeFilterChange={action} onSortChange={action}
      onToggleSession={action} onClearFilter={action} onSelectFiltered={action}
      onClearSelection={action} onSetSelectedSessions={action} />
    <RecentWorkspacesPanel translate={translateWorkspaces} workspaces={[]} filteredWorkspaces={[]}
      query="" onQueryChange={action} onClearFilter={action} />
  </>);
  translateSessions.mockClear();
  translateWorkspaces.mockClear();
  const previous = useAppStore.getState().statusMessage;
  act(() => useAppStore.setState({ statusMessage: "workspace file selected" }));
  expect(translateSessions).not.toHaveBeenCalled();
  expect(translateWorkspaces).not.toHaveBeenCalled();
  act(() => useAppStore.setState({ statusMessage: previous }));
  const loading = useSessionStore.getState().loading;
  act(() => useSessionStore.setState({ loading: !loading }));
  expect(translateSessions).not.toHaveBeenCalled();
  expect(translateWorkspaces).not.toHaveBeenCalled();
  act(() => useSessionStore.setState({ loading }));
});

it("still updates session context data when session groups change", () => {
  const translate = vi.fn((key: string) => key);
  const action = vi.fn();
  render(<RecentSessionsPanel translate={translate} sessions={[]} filteredSessions={[]}
    typeOptions={[]} query="" typeFilter="all" sort="last-desc"
    selectedIds={new Set()} selectedCount={0} selectedSessions={[]}
    onQueryChange={action} onTypeFilterChange={action} onSortChange={action}
    onToggleSession={action} onClearFilter={action} onSelectFiltered={action}
    onClearSelection={action} onSetSelectedSessions={action} />);
  translate.mockClear();
  act(() => useSessionStore.setState({ groups: [...useSessionStore.getState().groups] }));
  expect(translate).toHaveBeenCalled();
});
