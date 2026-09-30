import type React from "react";
import { useMemo, useRef, useState } from "react";
import { ArrowUpDown, Search, X } from "lucide-react";
import type { EvaluateResult } from "../../dapDebugModel";
import { VariableRow } from "./VariableRow";
import {
  Empty,
  parseVariables,
  updateNode,
  type VarEditState,
  type VarNode,
} from "./debugPanelShared";

export interface DebugVariablesPaneProps {
  variables: VarNode[];
  watchNodes: VarNode[];
  filterQuery?: string;
  onFilterQueryChange?: (value: string) => void;
  sortMode?: "natural" | "alphabetical";
  onToggleSortMode?: () => void;
  watchInput: string;
  onWatchInputChange: (value: string) => void;
  onAddWatch: () => void;
  onRemoveWatch: (target: number | string) => void;
  edit: VarEditState;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onStartEdit: (node: VarNode) => void;
  onExpandVariable: (node: VarNode) => void;
  onExpandWatch: (node: VarNode) => void;
  onAddDataBreakpoint?: (node: VarNode) => void;
  addingDataBreakpointKey?: string | null;
  dataBreakpointNotice?: { added: boolean; message: string } | null;
  onVariableContextMenu: (e: React.MouseEvent, node: VarNode, onRemove?: () => void) => void;
  stopped: boolean;
  canSetVariable: boolean;
  canAddDataBreakpoint: boolean;
  variableMenuRender?: React.ReactNode;
  /** Scopes ids to one workspace tab. */
  instanceId?: string;
  /** Evaluate the field's expression in the selected frame (Enter). */
  onEvaluate?: (expression: string) => Promise<EvaluateResult>;
  /** Expand an evaluation result node. */
  fetchVariables?: (variablesReference: number) => Promise<unknown>;
}

interface FlatRow {
  key: string;
  parentKey: string | null;
  node: VarNode;
  kind: "result" | "watch" | "variable";
}

function flatten(nodes: VarNode[], prefix: string, kind: FlatRow["kind"], parentKey: string | null, out: FlatRow[]) {
  nodes.forEach((node, index) => {
    const key = `${prefix}/${index}:${node.name}`;
    out.push({ key, parentKey, node, kind });
    if (node.expanded && node.children) flatten(node.children, key, kind, key, out);
  });
}

/**
 * IDEA's Variables view: the "Evaluate expression (Enter) or add a watch
 * (Ctrl+Shift+Enter)" field, watches merged above the frame's variables, and
 * a keyboard-driven tree (arrows, F2 Set Value, Ctrl+C Copy Value, Delete
 * removes a watch, Insert returns to the field).
 */
export function DebugVariablesPane({
  variables,
  watchNodes,
  filterQuery = "",
  onFilterQueryChange,
  sortMode = "natural",
  onToggleSortMode,
  watchInput,
  onWatchInputChange,
  onAddWatch,
  onRemoveWatch,
  edit,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onStartEdit,
  onExpandVariable,
  onExpandWatch,
  onAddDataBreakpoint,
  addingDataBreakpointKey,
  dataBreakpointNotice,
  onVariableContextMenu,
  stopped,
  canSetVariable,
  canAddDataBreakpoint,
  variableMenuRender,
  onEvaluate,
  fetchVariables,
}: DebugVariablesPaneProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [result, setResult] = useState<VarNode | null>(null);
  const [filterOpen, setFilterOpen] = useState(!!filterQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    if (result) flatten([result], "r", "result", null, out);
    flatten(watchNodes, "w", "watch", null, out);
    flatten(variables, "v", "variable", null, out);
    return out;
  }, [result, variables, watchNodes]);

  const evaluateField = async () => {
    const expression = watchInput.trim();
    if (!expression || !onEvaluate || !stopped) return;
    const value = await onEvaluate(expression);
    setResult({
      name: expression,
      value: value.value,
      type: value.type,
      variablesReference: value.variablesReference,
      parentRef: 0,
      children: null,
      expanded: false,
      dataBreakpointExpression: true,
    });
    setSelectedKey(`r/0:${expression}`);
  };

  const expandResult = (node: VarNode) => {
    setResult((current) => (current ? updateNode([current], node, (n) => ({ ...n, expanded: !n.expanded }))[0] ?? current : current));
    if (!node.expanded && node.children === null && node.variablesReference > 0 && fetchVariables) {
      void fetchVariables(node.variablesReference).then((body) => {
        const children = parseVariables(body, node.variablesReference);
        setResult((current) => (current
          ? updateNode([current], node, (n) => ({ ...n, children, expanded: true }))[0] ?? current
          : current));
      });
    }
  };

  const expandFor = (row: FlatRow) => (
    row.kind === "result" ? expandResult : row.kind === "watch" ? onExpandWatch : onExpandVariable
  );

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (edit.node) return;
    const index = rows.findIndex((row) => row.key === selectedKey);
    const current = index >= 0 ? rows[index] : null;
    const select = (row: FlatRow | undefined) => {
      if (!row) return;
      event.preventDefault();
      setSelectedKey(row.key);
      treeRef.current?.querySelector(`[data-var-key="${CSS.escape(row.key)}"]`)?.scrollIntoView?.({ block: "nearest" });
    };
    if (event.key === "ArrowDown") return select(rows[Math.min(rows.length - 1, index + 1)] ?? rows[0]);
    if (event.key === "ArrowUp") return select(rows[Math.max(0, index - 1)]);
    if (event.key === "Home") return select(rows[0]);
    if (event.key === "End") return select(rows[rows.length - 1]);
    if (event.key === "Insert") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (!current) return;
    const { node } = current;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (node.variablesReference > 0 && !node.expanded) expandFor(current)(node);
      else if (node.expanded && node.children?.length) select(rows[index + 1]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.expanded) expandFor(current)(node);
      else select(rows.find((row) => row.key === current.parentKey));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (node.variablesReference > 0) expandFor(current)(node);
    } else if (event.key === "F2" && current.kind === "variable" && canSetVariable && stopped && node.parentRef > 0) {
      event.preventDefault();
      onStartEdit(node);
    } else if (event.key === "Delete" && current.kind === "watch" && current.parentKey == null) {
      event.preventDefault();
      onRemoveWatch(node.watchId ?? node.name);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void navigator.clipboard?.writeText(node.value);
    }
  };

  const nothing = variables.length === 0 && watchNodes.length === 0 && !result;

  return (
    <div
      data-testid="debug-variables-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      <div className="h-7 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-1.5">
        <input
          ref={inputRef}
          data-testid="debug-watch-input"
          aria-label="Evaluate expression or add a watch"
          className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-[var(--taomni-accent)]"
          placeholder="Evaluate expression (Enter) or add a watch (Ctrl+Shift+Enter)"
          value={watchInput}
          onChange={(e) => onWatchInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                treeRef.current?.focus();
                if (!selectedKey && rows[0]) setSelectedKey(rows[0].key);
              }
              return;
            }
            e.preventDefault();
            if ((e.ctrlKey || e.metaKey) && e.shiftKey) onAddWatch();
            else if (onEvaluate && stopped) void evaluateField();
            else onAddWatch();
          }}
        />
        {onFilterQueryChange && (
          filterOpen || filterQuery ? (
            <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 py-0.5">
              <Search className="h-2.5 w-2.5 text-[var(--taomni-text-muted)] shrink-0" />
              <input
                data-testid="debug-variables-search"
                aria-label="Filter variables"
                className="w-16 sm:w-24 bg-transparent text-[10px] outline-none"
                placeholder="Filter..."
                value={filterQuery}
                autoFocus={filterOpen && !filterQuery}
                onChange={(e) => onFilterQueryChange(e.target.value)}
              />
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => {
                  onFilterQueryChange("");
                  setFilterOpen(false);
                }}
                className="text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="debug-variables-search-toggle"
              aria-label="Filter variables"
              title="Filter variables"
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)]"
              onClick={() => setFilterOpen(true)}
            >
              <Search className="h-3 w-3 text-[var(--taomni-text-muted)]" />
            </button>
          )
        )}
        {onToggleSortMode && (
          <button
            type="button"
            data-testid="debug-variables-sort"
            aria-pressed={sortMode === "alphabetical"}
            onClick={onToggleSortMode}
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] aria-pressed:bg-[var(--taomni-accent)]/20"
            title="Sort Variables Alphabetically"
          >
            <ArrowUpDown className="h-3 w-3 text-[var(--taomni-text-muted)]" />
          </button>
        )}
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Variables"
        tabIndex={0}
        data-testid="debug-variables-tree"
        className="flex-1 min-h-0 overflow-auto py-1 outline-none"
        onKeyDown={onTreeKeyDown}
        onFocus={() => {
          if (!selectedKey && rows[0]) setSelectedKey(rows[0].key);
        }}
      >
        {nothing ? (
          <Empty text={stopped ? "No variables" : "Variables are available while the program is suspended"} />
        ) : (
          <>
            {result && (
              <div data-testid="debug-evaluate-inline-result">
                <VariableRow
                  node={result}
                  depth={0}
                  onExpand={expandResult}
                  rowKey={`r/0:${result.name}`}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  onRemove={() => setResult(null)}
                  onContextMenu={onVariableContextMenu}
                />
              </div>
            )}
            {watchNodes.map((node, i) => (
              <VariableRow
                key={node.watchId ?? `${node.name}:${i}`}
                node={node}
                depth={0}
                watch
                onExpand={onExpandWatch}
                onRemove={() => onRemoveWatch(node.watchId ?? node.name)}
                onAddDataBreakpoint={canAddDataBreakpoint ? onAddDataBreakpoint : undefined}
                addingDataBreakpointKey={addingDataBreakpointKey}
                onContextMenu={onVariableContextMenu}
                rowKey={`w/${i}:${node.name}`}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
            ))}
            {variables.map((node, i) => (
              <VariableRow
                key={`${node.name}:${i}`}
                node={node}
                depth={0}
                onExpand={onExpandVariable}
                onStartEdit={canSetVariable && stopped ? onStartEdit : undefined}
                edit={edit}
                onEditChange={onEditChange}
                onEditSubmit={onEditSubmit}
                onEditCancel={onEditCancel}
                onAddDataBreakpoint={canAddDataBreakpoint ? onAddDataBreakpoint : undefined}
                addingDataBreakpointKey={addingDataBreakpointKey}
                onContextMenu={onVariableContextMenu}
                rowKey={`v/${i}:${node.name}`}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
            ))}
          </>
        )}
        {dataBreakpointNotice && (
          <div
            data-testid="debug-data-breakpoint-notice"
            role="status"
            className={`px-3 py-1 text-[10px] ${
              dataBreakpointNotice.added ? "text-emerald-500" : "text-rose-500"
            }`}
          >
            {dataBreakpointNotice.message}
          </div>
        )}
      </div>

      {variableMenuRender}
    </div>
  );
}
