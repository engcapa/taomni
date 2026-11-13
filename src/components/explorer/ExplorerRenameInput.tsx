import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "../../lib/sftp";
import { useExplorerContext } from "./ExplorerContext";

export function ExplorerRenameInput({ entry }: { entry: FileEntry }) {
  const { operations } = useExplorerContext();
  const [value, setValue] = useState(entry.name);
  const input = useRef<HTMLInputElement>(null);
  const committing = useRef(false);
  const dismissed = useRef(false);
  useEffect(() => {
    input.current?.focus();
    const end = entry.fileType !== "dir" && entry.name.lastIndexOf(".") > 0 ? entry.name.lastIndexOf(".") : entry.name.length;
    input.current?.setSelectionRange(0, end);
  }, [entry]);
  const commit = async () => {
    if (committing.current || dismissed.current) return;
    committing.current = true;
    const success = await operations.rename(entry, value);
    committing.current = false;
    if (!success) input.current?.focus();
  };
  return <input ref={input} data-testid="explorer-rename-input" aria-label="Rename" value={value}
    onChange={(event) => setValue(event.target.value)} spellCheck={false}
    onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); void commit(); }
      if (event.key === "Escape") { dismissed.current = true; operations.setRenamePath(null); }
    }} onBlur={() => { void commit(); }} />;
}
