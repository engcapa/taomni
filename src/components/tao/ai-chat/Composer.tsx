import { taoText as tr } from "../i18n";
import { Mic, Paperclip, Plus, Radio, ArrowUp, Square, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAiStore } from "../../../stores/aiStore";
import { isChatSendKey, normalizeChatSendShortcut } from "../../../lib/chat/sendShortcut";
import { getAppPlatform } from "../../../lib/runtime";
import { TaoProviderControls } from "./ProviderControls";
import { TaoPopover, useTaoPopover } from "./Popover";
import type { ContextChip, TaoChatController, TaoChatState } from "./ports";

export function TaoComposer({ controller, state, disabled = false }: { controller: TaoChatController; state: TaoChatState; disabled?: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plus = useTaoPopover();
  const capabilities = useTaoPopover();
  const shortcut = normalizeChatSendShortcut(useAiStore((value) => value.config?.chat_send_shortcut));
  const shortcutLabel = shortcut === "enter" ? "Enter" : getAppPlatform() === "macos" ? "⌘Enter" : "Ctrl+Enter";
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
          {state.composer.chips.map((chip) => <ContextChipView key={chip.id} chip={chip} demo={state.ui.demoMode} onRemove={() => controller.removeChip(chip.id)} />)}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        data-testid="tao-home-composer-input"
        aria-label={tr("给 Tao 的消息")}
        value={state.composer.text}
        disabled={disabled}
        placeholder={disabled ? tr("请先配置 Tao 服务提供方") : tr("问 Tao 任何开发问题…（{key} 发送）", { key: shortcutLabel })}
        onChange={(event) => controller.setComposerText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && active) { event.preventDefault(); void controller.stop(); return; }
          if (isChatSendKey({ ...event, isComposing: event.nativeEvent.isComposing }, shortcut)) { event.preventDefault(); onSubmit(); }
          if (event.key === "@" && !event.nativeEvent.isComposing) controller.setSearchOpen(true);
        }}
      />
      <div className="tao-home-composer-toolbar">
        <div className="tao-home-composer-tools">
          <button ref={plus.triggerRef} type="button" className="tao-home-tool-button" aria-label={tr("添加附件")} data-testid="tao-home-plus" onClick={() => plus.setOpen(!plus.open)}><Plus size={16} /></button>
          <button ref={capabilities.triggerRef} type="button" className={`tao-home-capability-button ${state.composer.thinking ? "on" : ""}`} data-testid="tao-home-capabilities" onClick={() => capabilities.setOpen(!capabilities.open)}>
            <Sparkles size={14} /> {state.composer.model.replace("deepseek-", "")} {state.composer.thinking ? `· ${tr("思考")}` : ""}{state.composer.web ? ` · ${tr("联网")}` : ""}
          </button>
          <TaoPopover owner={plus} label={tr("添加上下文")}><div className="tao-home-popup-items"><button type="button" data-testid="tao-home-context-attach" onClick={() => { controller.setSidePanel("文件"); plus.close(false); }}><Paperclip size={14} />{tr("引用文件")}</button><button type="button" data-testid="tao-home-context-workflows" onClick={() => { controller.setSidePanel("工作流"); plus.close(false); }}>{tr("技能 / 工作流")}</button><button type="button" data-testid="tao-home-context-local" onClick={() => { controller.setSearchOpen(true); plus.close(false); }}>{tr("本地资料")}</button></div></TaoPopover>
          <TaoPopover owner={capabilities} label={tr("模型与能力")}><div className="tao-home-popup-items">
            <TaoProviderControls controller={controller} state={state} onClose={() => capabilities.close(false)} />
          </div></TaoPopover>
        </div>
        <div className="tao-home-composer-right">
          <button type="button" className="tao-home-tool-button" aria-label={tr("录音")} data-testid="tao-home-voice" onClick={() => controller.setSidePanel("语音")}><Mic size={16} /></button>
          {active ? <button type="button" className="tao-home-send-button stop" data-testid="tao-home-stop" aria-label={tr("停止生成")} onClick={() => void controller.stop()}><Square size={14} /></button> : <button type="button" className="tao-home-send-button" data-testid="tao-home-send" aria-label={tr("发送")} disabled={disabled || actionWaiting || !state.composer.text.trim()} onClick={onSubmit}><ArrowUp size={17} /></button>}
        </div>
      </div>
      <div className="tao-home-composer-footer">
        <span data-testid="tao-home-shortcut-hint">{tr("{key} 发送", { key: shortcutLabel })}</span>
        {state.composer.web ? <span className="tao-home-cost-hint"><Radio size={11} />{tr("联网会产生费用（估算）")}</span> : null}
        {state.composer.chips.length > 0 ? <span>{tr("本次将发送：正文 + {count} 条本地资料", { count: state.composer.chips.length })}</span> : null}
        {actionWaiting ? <span className="tao-home-action-lock">{tr("请先处理上方动作提议")}</span> : null}
      </div>
    </div>
  );
}

function ContextChipView({ chip, onRemove, demo }: { chip: ContextChip; onRemove: () => void; demo: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return <span className="tao-home-context-chip"><button type="button" className="tao-home-context-chip-label" aria-label={tr("预览 {label}", { label: demo ? chip.kind : chip.label })} onClick={() => setPreviewOpen(!previewOpen)}>@{demo ? chip.kind : chip.label}</button>{chip.removable !== false ? <button type="button" aria-label={tr("移除 {label}", { label: demo ? chip.kind : chip.label })} onClick={onRemove}><X size={11} /></button> : null}{previewOpen ? <span className="tao-home-context-preview" role="dialog" aria-label={tr("{label} 的脱敏预览", { label: demo ? chip.kind : chip.label })}>{demo ? tr("演示模式下已隐藏内容") : chip.preview ?? tr("该上下文尚无可预览内容。")}<button type="button" onClick={() => setPreviewOpen(false)}>{tr("关闭")}</button></span> : null}</span>;
}
