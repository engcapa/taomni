import { taoText as tr } from "../i18n";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import type { TaoChatController } from "../ai-chat";

const SUGGESTIONS = ["解释一个终端报错", "帮我排查最近的构建失败", "写一个安全的 SQL 查询", "深研一个技术方案"];

export function SuggestionRow({ controller, hidden = false }: { controller: TaoChatController; hidden?: boolean }) {
  if (hidden) return null;
  return <div className="tao-home-suggestion-row" data-testid="tao-home-suggestions"><div className="tao-home-suggestion-label"><Lightbulb size={13} />{tr("可以这样问")}</div>{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} title={tr(suggestion)} aria-label={tr(suggestion)} onClick={(event) => { controller.setComposerText(tr(suggestion)); event.currentTarget.closest(".tao-ai-chat")?.querySelector<HTMLTextAreaElement>("[data-testid='tao-home-composer-input']")?.focus(); }}><span>{tr(suggestion)}</span><ArrowUpRight size={12} /></button>)}</div>;
}
