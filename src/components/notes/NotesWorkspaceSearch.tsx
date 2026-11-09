import { Search, X } from "lucide-react";
import { useRef } from "react";
import { useT } from "../../lib/i18n";

interface NotesWorkspaceSearchProps {
  value: string;
  onSearch: (search: string) => void;
}

export function NotesWorkspaceSearch({ value, onSearch }: NotesWorkspaceSearchProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clear = () => {
    onSearch("");
    inputRef.current?.focus();
  };
  return <div className="relative mt-1">
    <Search className="pointer-events-none absolute left-1.5 top-2 h-3 w-3 text-[var(--taomni-text-muted)]" />
    <input ref={inputRef} type="search" data-testid="notes-workspace-search" className="notes-workspace-search taomni-input h-7 w-full pl-6 pr-6 text-xs"
      aria-label={t("notes.searchAria")} placeholder={t("notes.searchPlaceholder")}
      value={value}
      onChange={(event) => onSearch(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !value || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
      }} />
    {value && <button type="button" data-testid="notes-workspace-search-clear"
      className="taomni-btn absolute right-1 top-1 flex h-5 w-5 items-center justify-center p-0"
      aria-label={t("notes.clearSearch")} title={t("notes.clearSearch")}
      onMouseDown={(event) => event.preventDefault()} onClick={clear}><X className="h-3 w-3" /></button>}
  </div>;

}
