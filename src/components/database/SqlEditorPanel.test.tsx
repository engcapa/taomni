import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbMetadataCache } from "../../lib/dbMetadataCache";
import {
  DEFAULT_SQL_COMPLETION_PREFERENCES,
  saveSqlCompletionPreferences,
} from "../../lib/sqlCompletionPreferences";
import {
  SqlEditorPanel,
  sqlCompletionKeymapFor,
  type SqlEditorHandle,
} from "./SqlEditorPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("SqlEditorPanel document updates", () => {
  it("coalesces document serialization and flushes the latest value", () => {
    vi.useFakeTimers();
    const onDocChange = vi.fn();
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="select 1"
        handleRef={(next) => {
          handle = next;
        }}
        onDocChange={onDocChange}
      />,
    );

    expect(handle).not.toBeNull();
    act(() => {
      handle?.setValue("select 2");
      handle?.setValue("select 22");
      vi.advanceTimersByTime(199);
    });
    expect(onDocChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onDocChange).toHaveBeenCalledTimes(1);
    expect(onDocChange).toHaveBeenLastCalledWith("select 22");

    act(() => handle?.setValue("select 3"));
    act(() => view.unmount());
    expect(onDocChange).toHaveBeenCalledTimes(2);
    expect(onDocChange).toHaveBeenLastCalledWith("select 3");
  });

  it("accepts an open completion with Tab", async () => {
    vi.useFakeTimers();
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="sel"
        handleRef={(next) => {
          handle = next;
        }}
        completionSources={[
          () => ({ from: 0, options: [{ label: "SELECT", type: "keyword" }] }),
        ]}
      />,
    );
    const content = view.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    act(() => handle?.selectRange(3, 3));
    fireEvent.keyDown(content!, { key: " ", code: "Space", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(view.container.querySelector(".cm-tooltip-autocomplete")).not.toBeNull();
    act(() => vi.advanceTimersByTime(80));

    fireEvent.keyDown(content!, { key: "Tab", code: "Tab" });
    expect((handle as SqlEditorHandle | null)?.getValue()).toBe("SELECT");
  });

  it("reconfigures the trigger shortcut live and removes the built-in Ctrl+Space binding", async () => {
    vi.useFakeTimers();
    const completionSource = vi.fn(() => ({
      from: 0,
      options: [{ label: "SELECT", type: "keyword" }],
    }));
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="sel"
        handleRef={(next) => {
          handle = next;
        }}
        completionSources={[completionSource]}
      />,
    );
    const content = view.container.querySelector<HTMLElement>(".cm-content");
    act(() => handle?.selectRange(3, 3));
    await act(async () => {
      saveSqlCompletionPreferences({
        ...DEFAULT_SQL_COMPLETION_PREFERENCES,
        triggerShortcut: "Alt-i",
      });
      await Promise.resolve();
    });

    fireEvent.keyDown(content!, { key: " ", code: "Space", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(100);
    });
    expect(completionSource).not.toHaveBeenCalled();
    expect(view.container.querySelector(".cm-tooltip-autocomplete")).toBeNull();

    fireEvent.keyDown(content!, { key: "i", code: "KeyI", altKey: true });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(completionSource).toHaveBeenCalled();
    expect(view.container.querySelector(".cm-tooltip-autocomplete")).not.toBeNull();
  });

  it("builds accept bindings from preferences", () => {
    const bindings = sqlCompletionKeymapFor({
      ...DEFAULT_SQL_COMPLETION_PREFERENCES,
      triggerShortcut: "Alt-i",
      acceptWithTab: false,
      acceptWithEnter: true,
    });

    expect(bindings.map((binding) => binding.key)).toContain("Alt-i");
    expect(bindings.map((binding) => binding.key)).toContain("Enter");
    expect(bindings.map((binding) => binding.key)).not.toContain("Tab");
    expect(bindings.map((binding) => binding.key)).toEqual(expect.arrayContaining([
      "Escape",
      "ArrowDown",
      "ArrowUp",
      "PageDown",
      "PageUp",
    ]));
  });

  it("opens downstream SELECT-list columns with the configured completion shortcut", async () => {
    vi.useFakeTimers();
    const metadataCache = {
      describeTable: vi.fn(async () => [
        { name: "id", type: "bigint", nullable: false, default: null, primaryKey: true },
        { name: "total", type: "decimal", nullable: true, default: null, primaryKey: false },
      ]),
      getDefaultCatalog: vi.fn(() => null),
    } as unknown as DbMetadataCache;
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="select  from orders"
        activeSchema="public"
        metadataCache={metadataCache}
        handleRef={(next) => {
          handle = next;
        }}
      />,
    );
    const content = view.container.querySelector<HTMLElement>(".cm-content");
    act(() => handle?.selectRange("select ".length, "select ".length));

    fireEvent.keyDown(content!, { key: " ", code: "Space", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(metadataCache.describeTable).toHaveBeenCalledWith("public", "orders", null);
    const labels = Array.from(view.container.querySelectorAll(".cm-completionLabel"))
      .map((node) => node.textContent);
    expect(labels).toEqual(expect.arrayContaining(["id", "total"]));
  });

  it("shows a delayed loading state for slow metadata completion", async () => {
    vi.useFakeTimers();
    const pending = deferred<Array<{ name: string; kind: "table"; rowCount: null }>>();
    const metadataCache = {
      searchTables: vi.fn(() => pending.promise),
      getDefaultCatalog: vi.fn(() => null),
    } as unknown as DbMetadataCache;
    let handle: SqlEditorHandle | null = null;
    const view = render(
      <SqlEditorPanel
        engine="PostgreSQL"
        initialDoc="select * from ord"
        activeSchema="public"
        metadataCache={metadataCache}
        handleRef={(next) => {
          handle = next;
        }}
      />,
    );
    const content = view.container.querySelector<HTMLElement>(".cm-content");

    act(() => handle?.selectRange("select * from ord".length, "select * from ord".length));
    fireEvent.keyDown(content!, { key: " ", code: "Space", ctrlKey: true });
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(metadataCache.searchTables).toHaveBeenCalled();
    expect(view.queryByTestId("sql-completion-status")).toBeNull();

    act(() => vi.advanceTimersByTime(120));
    expect(view.getByTestId("sql-completion-status")).toHaveTextContent(
      "Loading metadata completions",
    );

    await act(async () => {
      pending.resolve([{ name: "orders", kind: "table", rowCount: null }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.queryByTestId("sql-completion-status")).toBeNull();
  });
});
