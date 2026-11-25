import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { explorerFileTypes, newFileNameError } from "./explorerFileTypes";
import { useExplorerLabels } from "./explorerLabels";
import type { ExplorerOperations } from "./useExplorerOperations";

export function ExplorerNewFileDialog({ operations }: { operations: ExplorerOperations }) {
  const label = useExplorerLabels();
  const types = useMemo(() => explorerFileTypes(label), [label]);
  const [type, setType] = useState("md");
  const [name, setName] = useState(() => operations.suggestFileName(types.find((item) => item.id === "md")!.name));
  const [attempted, setAttempted] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  const explorer = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const error = newFileNameError(name, label);
  const message = attempted && error || operations.newFileError;
  useLayoutEffect(() => { explorer.current = root.current?.closest<HTMLElement>(".ex-shell") ?? null; }, []);
  useFocusReturn(true, () => explorer.current?.querySelector<HTMLElement>('[data-testid="explorer-cmd-new"]')?.focus());
  const close = () => { if (!operations.busy) operations.setNewFile(false); };
  return <div className="ex-dialog-back" onPointerDown={(event) => event.stopPropagation()}>
    <form ref={root} className="ex-dialog" data-testid="explorer-new-file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "Tab") {
          const controls = Array.from(root.current?.elements ?? []).filter((element): element is HTMLElement =>
            element instanceof HTMLElement && !element.matches(":disabled"));
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }} onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (!error && !operations.busy) void operations.createFile(name);
      }}>
      <h3 id={titleId}>{label("新建文件", "New file")}</h3>
      <label className="ex-new-file-field">{label("文件类型", "File type")}
        <select autoFocus data-testid="explorer-new-file-type" value={type} disabled={operations.busy} onChange={(event) => {
          const next = types.find((item) => item.id === event.target.value)!;
          setType(next.id); setName(operations.suggestFileName(next.name)); setAttempted(false);
        }}>
          {[...new Set(types.map((item) => item.group))].map((group) => <optgroup key={group} label={group}>
            {types.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </optgroup>)}
        </select>
      </label>
      <label className="ex-new-file-field">{label("文件名", "File name")}
        <input data-testid="explorer-new-file-name" value={name} disabled={operations.busy} spellCheck={false}
          aria-invalid={attempted && !!error} onChange={(event) => setName(event.target.value)} />
      </label>
      <p>{label("创建空文件，双击后使用对应编辑器打开。", "Create an empty file, then double-click to open its editor.")}</p>
      {message && <p role="alert" data-testid="explorer-new-file-error">{message}</p>}
      <div className="ex-dialog-footer">
        <button type="button" data-testid="explorer-new-file-cancel" disabled={operations.busy} onClick={close}>{label("取消", "Cancel")}</button>
        <button type="submit" data-testid="explorer-new-file-create" disabled={operations.busy}>{label("创建", "Create")}</button>
      </div>
    </form>
  </div>;
}
