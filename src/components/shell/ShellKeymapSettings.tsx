import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { expandShellKey, normalizeShellKey, reservedShellKey, SHELL_BINDABLE_ACTIONS, useShellKeymapStore } from "../../lib/shell/shellKeymap";
import type { ShellAction } from "../../lib/shell/shellActions";
import { surfaceKeyConflicts } from "../../lib/shellKeyClaims";
import { strokeFromKeyboardEvent, type ShortcutStroke } from "../editor/workspace/workspaceKeymapScheme";

export function ShellKeymapSettings() {
  const store = useShellKeymapStore(), t = useT();
  const [recording, setRecording] = useState<ShellAction | null>(null), [draft, setDraft] = useState("");
  const [stroke, setStroke] = useState<ShortcutStroke | null>(null);
  const opener = useRef<HTMLElement | null>(null), dialog = useRef<HTMLDivElement>(null);
  const conflicts = stroke ? surfaceKeyConflicts(stroke) : [];
  const conflict = !!draft && (Object.entries(store.bindings).some(([action, key]) => action !== recording && key && expandShellKey(key) === draft) || reservedShellKey(draft) || !draft.includes("+") || conflicts.length > 0);
  useEffect(() => {
    if (!recording) return;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [recording]);
  return <section data-testid="shell-keymap" className="mt-4 border-t border-[var(--taomni-divider)] pt-3"><h3 className="text-sm font-semibold mb-2">{t("shell.keymap")}</h3>
    {SHELL_BINDABLE_ACTIONS.map((action) => <div key={action} data-testid="shell-keymap-row" data-action-id={action} className="flex items-center gap-2 py-1"><span className="flex-1 text-xs">{t(`shell.${action.slice(6).replace("navigator.toggle", "navigator").replace("tao.toggle", "tao").replace("panel.open", "panel")}`)}</span><kbd className="text-xs">{store.bindings[action]}</kbd><button data-testid="shell-keymap-record" className="taomni-btn px-2" onClick={(e) => { opener.current = e.currentTarget; setRecording(action); setDraft(""); setStroke(null); }}>{t("shell.record")}</button></div>)}
    {recording && <div ref={dialog} role="dialog" aria-modal="true" data-testid="shell-keymap-dialog" tabIndex={-1} className="border p-3" onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRecording(null); return; }
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const controls = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation(); setDraft(normalizeShellKey(e.nativeEvent)); setStroke(strokeFromKeyboardEvent(e.nativeEvent));
    }}>
      <button autoFocus data-testid="shell-keymap-capture" className="taomni-button p-2">{draft || t("shell.record")}</button>
      {conflict && <div role="alert" data-testid="shell-keymap-conflict"><p>{t("shell.keymapConflict")}</p>{conflicts.map((item) => <p key={`${item.scope}:${item.actionId}`} data-testid="shell-keymap-conflict-scope">{item.scope}: {item.title}</p>)}</div>}
      <button data-testid="shell-keymap-save" disabled={!draft || conflict} onClick={() => { store.setBinding(recording, draft); setRecording(null); }}>{t("common.save")}</button>
      <button data-testid="shell-keymap-cancel" onClick={() => setRecording(null)}>{t("common.cancel")}</button>
    </div>}
  </section>;
}
