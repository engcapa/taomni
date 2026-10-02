import type React from "react";
import { ChevronDown, ChevronRight, Crosshair, Glasses } from "lucide-react";
import { variableValueText } from "../../debugBreakpointProperties";
import {
  variableDataBreakpointTargetKey,
  type VarEditState,
  type VarNode,
} from "./debugPanelShared";

export interface VariableRowProps {
  node: VarNode;
  depth: number;
  onExpand: (node: VarNode) => void;
  /** Present when the value is editable (DAP setVariable). */
  onStartEdit?: (node: VarNode) => void;
  edit?: VarEditState;
  onEditChange?: (value: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
  /** Present on watch roots: remove the watch expression. */
  onRemove?: () => void;
  /** Present while stopped when the adapter supports data breakpoints. */
  onAddDataBreakpoint?: (node: VarNode) => void;
  addingDataBreakpointKey?: string | null;
  onContextMenu?: (e: React.MouseEvent, node: VarNode, onRemove?: () => void) => void;
  /** Tree identity of this row for keyboard selection (`w/0:expr`, `v/1:x`). */
  rowKey?: string;
  selectedKey?: string | null;
  onSelect?: (key: string, node: VarNode) => void;
  /** Watch roots carry IDEA's watch icon. */
  watch?: boolean;
}

export function VariableRow({
  node,
  depth,
  onExpand,
  onStartEdit,
  edit,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onRemove,
  onAddDataBreakpoint,
  addingDataBreakpointKey,
  onContextMenu,
  rowKey,
  selectedKey,
  onSelect,
  watch = false,
}: VariableRowProps) {
  const expandable = node.variablesReference > 0;
  const editing = edit?.node === node;
  const dataTargetKey = variableDataBreakpointTargetKey(node);
  const dataBreakpointEligible = node.parentRef > 0 || node.dataBreakpointExpression;
  const key = rowKey ?? node.name;
  const selected = selectedKey != null && selectedKey === key;
  // Scope nodes (Local, Static…) have no value of their own.
  const scopeHeader = node.parentRef === 0 && !watch && node.value === "" && node.type == null && depth === 0;
  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? node.expanded : undefined}
        data-var-key={key}
        className={`group flex items-start gap-1 py-0.5 pr-2 cursor-default select-none ${
          selected ? "bg-[var(--taomni-accent)]/20" : "hover:bg-[var(--taomni-hover-bg)]"
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect?.(key, node)}
        onContextMenu={(e) => {
          onSelect?.(key, node);
          onContextMenu?.(e, node, onRemove);
        }}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(key, node);
              onExpand(node);
            }}
          >
            {node.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        {watch && <Glasses aria-label="Watch" className="mt-px h-3 w-3 shrink-0 text-[var(--taomni-text-muted)]" />}
        <span
          className={`shrink-0 ${scopeHeader ? "font-medium" : "text-[#9876aa] dark:text-[#c77dbb]"}`}
          title={node.type ?? undefined}
        >
          {node.name}
        </span>
        {editing ? (
          <input
            autoFocus
            data-testid="debug-variable-edit-input"
            className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 font-mono text-[11px] outline-none"
            value={edit?.value ?? ""}
            onChange={(e) => onEditChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit?.();
              else if (e.key === "Escape") onEditCancel?.();
            }}
            onBlur={() => onEditCancel?.()}
          />
        ) : scopeHeader ? null : (
          <span
            data-testid={node.hasChanged ? "debug-variable-changed" : undefined}
            className={`truncate ${
              node.hasChanged
                ? "text-amber-600 dark:text-amber-400 font-semibold bg-amber-500/10 px-1 rounded"
                : "text-[var(--taomni-text)]"
            }`}
            title={onStartEdit ? "Set Value (F2), or double-click" : undefined}
            onDoubleClick={onStartEdit ? () => onStartEdit(node) : undefined}
          >
            = {variableValueText(node.value)}
          </span>
        )}
        {(onRemove || (dataBreakpointEligible && onAddDataBreakpoint)) && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {dataBreakpointEligible && onAddDataBreakpoint && (
              <button
                type="button"
                tabIndex={-1}
                data-testid="debug-variable-data-breakpoint"
                className="text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100 hover:text-rose-500 disabled:opacity-30"
                onClick={() => onAddDataBreakpoint(node)}
                disabled={addingDataBreakpointKey === dataTargetKey}
                title={`Add data breakpoint for ${node.name}`}
                aria-label={`Add data breakpoint for ${node.name}`}
              >
                <Crosshair className="h-3 w-3" />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                tabIndex={-1}
                className="text-[var(--taomni-text-muted)] opacity-0 group-hover:opacity-100"
                onClick={onRemove}
                title="Remove watch"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>
      {node.expanded && node.children?.map((child, i) => (
        <VariableRow
          key={`${child.name}:${i}`}
          node={child}
          depth={depth + 1}
          onExpand={onExpand}
          onStartEdit={onStartEdit}
          edit={edit}
          onEditChange={onEditChange}
          onEditSubmit={onEditSubmit}
          onEditCancel={onEditCancel}
          onAddDataBreakpoint={onAddDataBreakpoint}
          addingDataBreakpointKey={addingDataBreakpointKey}
          onContextMenu={onContextMenu}
          rowKey={`${key}/${i}:${child.name}`}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
