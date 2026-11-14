import { Database, FolderKanban, Terminal, X } from "lucide-react";
import { useState } from "react";
import type { ContextChip, TaoChatController } from "../ai-chat";

const BINDINGS: Array<{ key: "workspace" | "terminal" | "database"; label: string; icon: typeof Terminal }> = [
  { key: "workspace", label: "工作区", icon: FolderKanban },
  { key: "terminal", label: "终端", icon: Terminal },
  { key: "database", label: "数据库", icon: Database },
];

export function BindingBar({ controller, context }: { controller: TaoChatController; context: Record<string, string | undefined> }) {
  const [open, setOpen] = useState<string | null>(null);
  const chips = controller.getState().composer.chips;
  return <div className="tao-home-binding-bar" data-testid="tao-home-binding-bar">{BINDINGS.map(({ key, label, icon: Icon }) => { const value = context[key]; return <div key={key} className="tao-home-binding-item"><button type="button" className={`tao-home-binding-chip ${value ? "bound" : "empty"}`} data-testid={`tao-home-binding-${key}`} title={value ? `会发送给模型的内容：仅在 @ 引用时发送已脱敏摘要` : `+ 绑定${label}`} onClick={() => setOpen(open === key ? null : key)}><Icon size={13} />{value ?? `+ 绑定${label}`}{value ? <X size={12} onClick={(event) => { event.stopPropagation(); controller.setContext({ ...context, [key]: undefined }); controller.setChips(chips.filter((chip) => chip.kind !== key)); }} /> : null}</button>{open === key ? <BindingPopover kind={key} label={label} context={context} controller={controller} onClose={() => setOpen(null)} /> : null}</div>; })}</div>;
}

function BindingPopover({ kind, label, context, controller, onClose }: { kind: string; label: string; context: Record<string, string | undefined>; controller: TaoChatController; onClose: () => void }) {
  const items = kind === "terminal" ? ["本地终端", "SSH · u80", "WSL · Ubuntu"] : kind === "database" ? ["PostgreSQL · 本地", "MySQL · u80"] : ["taomni-ai-devbuddy-1", "当前工作区"];
  return <div className="tao-home-binding-popover" role="dialog"><strong>绑定{label}</strong><p>绑定本身不会发送内容。仅在你 @ 引用时发送最近摘要（已脱敏）。</p>{items.map((item) => <button type="button" key={item} onClick={() => { controller.setContext({ ...context, [kind]: item }); const chip: ContextChip = { id: `${kind}-${item}`, kind: kind as ContextChip["kind"], label: item, preview: "已脱敏摘要", removable: true }; controller.setChips([...controller.getState().composer.chips.filter((old) => old.kind !== kind), chip]); onClose(); }}>{item}</button>)}<button type="button" className="secondary" onClick={onClose}>关闭</button></div>;
}
