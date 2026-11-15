import { taoText as tr } from "../i18n";
import { Database, FolderKanban, Terminal, X } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../../stores/appStore";
import type { TaoChatController } from "../ai-chat";
import { TaoPopover, useTaoPopover } from "../ai-chat/Popover";
import { listBindingResources, resolveBindingChip, type BindingResource } from "./bindingResources";

const BINDINGS = [
  { kind: "workspace", label: "工作区", icon: FolderKanban },
  { kind: "terminal", label: "终端", icon: Terminal },
  { kind: "database", label: "数据库", icon: Database },
] as const;

export function BindingBar({ controller, context }: { controller: TaoChatController; context: Record<string, string | undefined> }) {
  useAppStore((state) => state.tabs);
  const demo = controller.getState().ui.demoMode;
  return <div className="tao-home-binding-bar" data-testid="tao-home-binding-bar">{BINDINGS.map((entry) => <BindingButton key={entry.kind} {...entry} demo={demo} controller={controller} value={context[`${entry.kind}Id`]} />)}</div>;
}

function BindingButton({ kind, label, icon: Icon, value, demo, controller }: typeof BINDINGS[number] & { value?: string; demo: boolean; controller: TaoChatController }) {
  const popup = useTaoPopover();
  const [error, setError] = useState("");
  const resources = popup.open ? listBindingResources(kind) : [];
  const resource = resources.find((item) => item.id === value) ?? listBindingResources(kind).find((item) => item.id === value);
  const bind = (item: BindingResource) => {
    const current = controller.getState();
    const next = { ...current.context, [`${kind}Id`]: item.id, [kind]: item.id };
    if (kind === "workspace") {
      const workspace = useAppStore.getState().codeWorkspaceByTab[item.id];
      if (workspace?.repoRoot) next.workspace = workspace.repoRoot;
    }
    controller.setContext(next);
    // An excerpt is an explicit grant for one bound resource. Rebinding must
    // not carry the previous resource's body into the next request.
    if (current.context[`${kind}Id`] !== item.id) {
      controller.setChips(current.composer.chips.filter((chip) => !chip.id.startsWith(`binding:${kind}:`)));
    }
    setError(""); popup.close();
  };
  const cite = () => {
    if (!resource) { setError(tr("绑定的资源已关闭，请重新选择。")); return; }
    try {
      const chip = resolveBindingChip(resource);
      const chips = controller.getState().composer.chips.filter((item) => item.id !== chip.id);
      controller.setChips([...chips, chip]);
      popup.close(false);
    } catch (cause) { setError(String(cause)); }
  };
  const unbind = () => {
    const next = { ...controller.getState().context, [`${kind}Id`]: undefined, [kind]: undefined };
    if (kind === "workspace") next.workspace = undefined;
    controller.setContext(next);
    controller.setChips(controller.getState().composer.chips.filter((chip) => !chip.id.startsWith(`binding:${kind}:`)));
    popup.close();
  };
  return <div className="tao-home-binding-item">
    <button ref={popup.triggerRef} type="button" className={`tao-home-binding-chip ${value ? "bound" : "empty"}`} data-testid={`tao-home-binding-${kind}`} aria-expanded={popup.open} onClick={() => popup.setOpen(!popup.open)}><Icon size={13} />{value ? demo ? tr(label) : resource?.label ?? tr("{kind}（已关闭）", { kind: tr(label) }) : tr("+ 绑定{kind}", { kind: tr(label) })}</button>
    <TaoPopover owner={popup} label={tr("绑定{kind}", { kind: tr(label) })}><div className="tao-home-popup-items"><strong>{tr("绑定{kind}", { kind: tr(label) })}</strong><p>{tr("绑定不会发送内容。选择后点击“引用到本次提问”预览并发送。")}</p>{resources.map((item, index) => <button type="button" data-testid="tao-home-binding-option" data-resource-id={item.id} key={item.id} onClick={() => bind(item)}>{demo ? `${tr(label)} ${index + 1}` : item.label}</button>)}{!resources.length ? <p>{tr("暂无可绑定的{kind}，请先打开对应资源。", { kind: tr(label) })}</p> : null}{value ? <><button type="button" data-testid="tao-home-binding-cite" onClick={cite}>{tr("@ 引用到本次提问")}</button><button type="button" data-testid="tao-home-binding-unbind" onClick={unbind}><X size={12} />{tr("解除绑定")}</button></> : null}{error ? <p role="alert">{error}</p> : null}</div></TaoPopover>
  </div>;
}
