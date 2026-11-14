import { Mic, Paperclip, Plus, Radio, Send, Square, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ContextChip, TaoChatController, TaoChatState } from "./ports";

export function TaoComposer({ controller, state, disabled = false }: { controller: TaoChatController; state: TaoChatState; disabled?: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<"plus" | "capabilities" | null>(null);
  const threadId = state.activeThreadId;
  const runtime = threadId ? state.runtime[threadId] : undefined;
  const active = runtime?.phase === "sending" || runtime?.phase === "thinking" || runtime?.phase === "searching" || runtime?.phase === "streaming";
  const actionWaiting = runtime?.phase === "awaiting_action" || runtime?.phase === "plan_pending";
  const onSubmit = () => { void controller.send(); };

  useEffect(() => {
    if (!disabled && !active) textareaRef.current?.focus();
  }, [disabled, active, threadId]);

  return (
    <div className={`tao-home-composer ${disabled ? "is-disabled" : ""} ${active ? "is-active" : ""}`} data-testid="tao-home-composer">
      {state.composer.chips.length > 0 ? (
        <div className="tao-home-context-chips" data-testid="tao-home-context-chips">
          {state.composer.chips.map((chip) => <ContextChipView key={chip.id} chip={chip} onRemove={() => controller.removeChip(chip.id)} />)}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        data-testid="tao-home-composer-input"
        aria-label="给 Tao 的消息"
        value={state.composer.text}
        disabled={disabled}
        placeholder={disabled ? "请先连接 DeepSeek · 全家桶" : "问 Tao 任何开发问题…（Ctrl+Enter 发送）"}
        onChange={(event) => controller.setComposerText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && active) { event.preventDefault(); void controller.stop(); return; }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); }
          if (event.key === "@" && !event.nativeEvent.isComposing) controller.setChips([...state.composer.chips, { id: `chip-${Date.now()}`, kind: "local", label: "本地资料", removable: true }]);
        }}
      />
      <div className="tao-home-composer-toolbar">
        <div className="tao-home-composer-tools">
          <button type="button" className="tao-home-tool-button" aria-label="添加附件" data-testid="tao-home-plus" onClick={() => setMenu(menu === "plus" ? null : "plus")}><Plus size={16} /></button>
          <button type="button" className={`tao-home-capability-button ${state.composer.thinking ? "on" : ""}`} data-testid="tao-home-capabilities" onClick={() => setMenu(menu === "capabilities" ? null : "capabilities")}>
            <Sparkles size={14} /> {state.composer.model.replace("deepseek-", "")} {state.composer.thinking ? "· 思考" : ""}{state.composer.web ? " · 联网" : ""}
          </button>
          {menu === "plus" ? <div className="tao-home-composer-menu" role="menu"><button type="button" onClick={() => { controller.setChips([...state.composer.chips, { id: `file-${Date.now()}`, kind: "file", label: "文件引用", removable: true }]); setMenu(null); }}><Paperclip size={14} />引用文件</button><button type="button" onClick={() => setMenu(null)}>技能 / 工作流</button></div> : null}
          {menu === "capabilities" ? <div className="tao-home-composer-menu" role="menu"><button type="button" onClick={() => controller.setComposerOption("thinking", !state.composer.thinking)}>思考 {state.composer.thinking ? "✓" : ""}</button><button type="button" onClick={() => controller.setComposerOption("web", !state.composer.web)}>联网 {state.composer.web ? "✓" : ""}</button><button type="button" onClick={() => controller.setModel(state.composer.model === "deepseek-flash" ? "deepseek-v4-pro" : "deepseek-flash")}>模型：{state.composer.model}</button></div> : null}
        </div>
        <div className="tao-home-composer-right">
          <button type="button" className="tao-home-tool-button" aria-label="录音" data-testid="tao-home-voice"><Mic size={16} /></button>
          {active ? <button type="button" className="tao-home-send-button stop" data-testid="tao-home-stop" aria-label="停止生成" onClick={() => void controller.stop()}><Square size={14} /></button> : <button type="button" className="tao-home-send-button" data-testid="tao-home-send" aria-label="发送" disabled={disabled || actionWaiting || !state.composer.text.trim()} onClick={onSubmit}><Send size={15} /></button>}
        </div>
      </div>
      <div className="tao-home-composer-footer">
        <span data-testid="tao-home-shortcut-hint">Ctrl+Enter 发送</span>
        {state.composer.web ? <span className="tao-home-cost-hint"><Radio size={11} /> 联网会产生费用（估算）</span> : null}
        {state.composer.chips.length > 0 ? <span>本次将发送：正文 + {state.composer.chips.length} 条本地资料</span> : null}
        {actionWaiting ? <span className="tao-home-action-lock">请先处理上方动作提议</span> : null}
      </div>
    </div>
  );
}

function ContextChipView({ chip, onRemove }: { chip: ContextChip; onRemove: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return <span className="tao-home-context-chip" title={chip.preview ? undefined : "点击预览脱敏内容"}><button type="button" className="tao-home-context-chip-label" aria-label={`预览 ${chip.label}`} onClick={() => setPreviewOpen(!previewOpen)}>@{chip.label}</button>{chip.removable !== false ? <button type="button" aria-label={`移除 ${chip.label}`} onClick={onRemove}><X size={11} /></button> : null}{previewOpen ? <span className="tao-home-context-preview" role="dialog" aria-label={`${chip.label} 的脱敏预览`}>{chip.preview ?? "该上下文尚无可预览内容。"}</span> : null}</span>;
}
