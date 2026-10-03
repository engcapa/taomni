import { useState } from "react";
import { useT } from "../../lib/i18n";
import { normalizeShellKey, SHELL_BINDABLE_ACTIONS, useShellKeymapStore } from "../../lib/shell/shellKeymap";
import type { ShellAction } from "../../lib/shell/shellActions";

export function ShellKeymapSettings() {
  const store = useShellKeymapStore(), t = useT();
  const [recording, setRecording] = useState<ShellAction | null>(null), [draft, setDraft] = useState("");
  const conflict = !!draft && (Object.entries(store.bindings).some(([action, key]) => action !== recording && key === draft) || draft === "Meta+Tab" || !draft.includes("+"));
  return <section data-testid="shell-keymap" className="mt-4 border-t border-[var(--taomni-divider)] pt-3"><h3 className="text-sm font-semibold mb-2">{t("shell.keymap")}</h3>
    {SHELL_BINDABLE_ACTIONS.map((action) => <div key={action} data-testid="shell-keymap-row" data-action-id={action} className="flex items-center gap-2 py-1"><span className="flex-1 text-xs">{t(`shell.${action.slice(6).replace("navigator.toggle", "navigator").replace("tao.toggle", "tao").replace("panel.open", "panel")}`)}</span><kbd className="text-xs">{store.bindings[action]}</kbd><button data-testid="shell-keymap-record" className="taomni-btn px-2" onClick={() => { setRecording(action); setDraft(""); }}>{t("shell.record")}</button></div>)}
    {recording && <div role="dialog" aria-modal="true" data-testid="shell-keymap-dialog" tabIndex={-1} className="border p-3" onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Escape") { setRecording(null); return; } if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); setDraft(normalizeShellKey(e.nativeEvent)); }}>
      <button autoFocus data-testid="shell-keymap-capture" className="taomni-button p-2">{draft || t("shell.record")}</button>
      {conflict && <p role="alert" data-testid="shell-keymap-conflict">{t("shell.keymapConflict")}</p>}
      <button data-testid="shell-keymap-save" disabled={!draft || conflict} onClick={() => { store.setBinding(recording, draft); setRecording(null); }}>{t("common.save")}</button>
      <button data-testid="shell-keymap-cancel" onClick={() => setRecording(null)}>{t("common.cancel")}</button>
    </div>}
  </section>;
}
