import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ModalSurface } from "../ui/ModalSurface";
import { explorerFileTypes, newFileNameError } from "./explorerFileTypes";
import { useExplorerLabels } from "./explorerLabels";
import type { ExplorerOperations } from "./useExplorerOperations";

export function ExplorerNewFileDialog({ operations }: { operations: ExplorerOperations }) {
  const label = useExplorerLabels();
  const types = useMemo(() => explorerFileTypes(label), [label]);
  const [type, setType] = useState("md");
  const [name, setName] = useState(() => operations.suggestFileName(types.find((item) => item.id === "md")!.name));
  const [attempted, setAttempted] = useState(false);
  const [opener] = useState<HTMLElement | null>(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return (
      active?.closest(".ex-shell")?.querySelector<HTMLElement>('[data-testid="explorer-cmd-new"]') ??
      document.querySelector<HTMLElement>('.ex-shell [data-testid="explorer-cmd-new"]') ??
      active
    );
  });
  const titleId = useId();
  const error = newFileNameError(name, label);
  const message = attempted && error || operations.newFileError;
  const close = () => { if (!operations.busy) operations.setNewFile(false); };
  return createPortal(
    <ModalSurface
      className="ex-dialog taomni-modal"
      data-testid="explorer-new-file-dialog"
      aria-labelledby={titleId}
      initialFocus='[data-testid="explorer-new-file-type"]'
      returnFocus={opener}
      onCancel={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (!error && !operations.busy) void operations.createFile(name);
        }}
      >
        <h3 id={titleId}>{label("新建文件", "New file")}</h3>
        <label className="ex-new-file-field">{label("文件类型", "File type")}
          <select data-testid="explorer-new-file-type" value={type} disabled={operations.busy} onChange={(event) => {
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
    </ModalSurface>,
    document.body,
  );
}
