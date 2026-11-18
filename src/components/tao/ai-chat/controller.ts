import { taoText as tr } from "../i18n";
import { completeReply } from "./replyCompletion";
import { actionKey, actionPending, createActionLifecycle } from "./actionLifecycle";
import { getBudgetWarning, mergeUsage } from "../budget";
import type {
  ActionPorts,
  BudgetPort,
  ChatBackend,
  ChatProfile,
  ContextPorts,
  TaoBlock,
  TaoChatController,
  TaoChatState,
  TaoEvent,
  TaoErrorCategory,
  TaoMessage,
  TaoRequest,
  TaoThread,
  TaoUsage,
} from "./ports";

export interface ChatControllerOptions {
  backend?: ChatBackend;
  profile?: Partial<ChatProfile>;
  contextPorts?: ContextPorts;
  actionPorts?: ActionPorts;
  budget?: Partial<BudgetPort>;
}

const DEFAULT_BUDGET: BudgetPort = { limitTokens: 10_000_000 };

function id(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return Date.now();
}

function classifyError(error: unknown): TaoErrorCategory {
  const text = String(error).toLowerCase();
  if (/vault_locked|vault (?:is )?locked/.test(text)) return "vault_locked";
  if (/invalid args|missing field|deserialize|protocol/.test(text)) return "protocol";
  if (/401|403|429|http|unauthorized/.test(text)) return "http";
  return "network";
}

function defaultState(profile: Partial<ChatProfile>, budget: Partial<BudgetPort>): TaoChatState {
  const threadId = id("tao-thread");
  const thread: TaoThread = { id: threadId, title: tr("新 Tao 对话"), messages: [], updatedAt: now(), source: "tao" };
  const limitTokens = budget.limitTokens ?? profile.budget?.limitTokens ?? DEFAULT_BUDGET.limitTokens;
  return {
    activeThreadId: threadId,
    threads: { [threadId]: thread },
    mode: "ask",
    context: {},
    composer: {
      text: "",
      chips: [],
      thinking: profile.defaultThinking ?? false,
      web: profile.defaultWeb ?? false,
      model: profile.defaultModel ?? "deepseek-flash",
      provider: profile.defaultProvider ?? "deepseek-app",
      reasoningEffort: profile.defaultReasoningEffort ?? "high", capabilities: profile.defaultCapabilities,
    },
    runtime: { [threadId]: { phase: "idle", budget: { usedTokens: 0, limitTokens, halted: false } } },
    ui: { sidePanel: null, demoMode: false, searchOpen: false },
  };
}

function asArray(events: AsyncIterable<TaoEvent> | Iterable<TaoEvent>): AsyncIterable<TaoEvent> {
  if (Symbol.asyncIterator in Object(events)) return events as AsyncIterable<TaoEvent>;
  return (async function* () { yield* events as Iterable<TaoEvent>; })();
}

export function createChatController(options: ChatControllerOptions = {}): TaoChatController {
  const profile: Partial<ChatProfile> = { ...options.profile };
  const budget: BudgetPort = { ...DEFAULT_BUDGET, ...profile.budget, ...options.budget };
  let state = defaultState(profile, budget);
  /** One transport/cancellation owner per thread.  Switching threads must
   * leave an in-flight request running in the background. */
  const running = new Map<string, AbortController>();
  const blockOffsets = new Map<string, number>();
  const usageCalls = new Map<string, { current: string; calls: Map<string, Partial<TaoUsage>> }>();
  const usageApplied = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const patch = (next: Partial<TaoChatState>) => {
    state = { ...state, ...next };
    const threadId = state.activeThreadId;
    if (threadId && state.threads[threadId] && (next.mode || next.composer || next.context)) {
      state = { ...state, threads: { ...state.threads, [threadId]: { ...state.threads[threadId], preferences: { mode: state.mode, context: state.context, composer: state.composer }, updatedAt: now() } } };
    }
    notify();
  };
  const activeRuntime = () => state.activeThreadId ? state.runtime[state.activeThreadId] : undefined;
  const patchThread = (threadId: string, updater: (thread: TaoThread) => TaoThread) => {
    const thread = state.threads[threadId];
    if (!thread) return;
    patch({ threads: { ...state.threads, [threadId]: updater(thread) } });
  };
  const patchRuntime = (threadId: string, updater: (runtime: TaoChatState["runtime"][string]) => TaoChatState["runtime"][string]) => {
    if (!state.threads[threadId]) return;
    const runtime = state.runtime[threadId] ?? { phase: "idle" as const, budget: { usedTokens: 0, limitTokens: budget.limitTokens, halted: false } };
    patch({ runtime: { ...state.runtime, [threadId]: updater(runtime) } });
  };

  const ensureAssistant = (threadId: string): TaoMessage => {
    const thread = state.threads[threadId];
    const last = thread.messages.at(-1);
    if (last?.role === "assistant") return last;
    const assistant: TaoMessage = { id: id("tao-assistant"), role: "assistant", text: "", blocks: [], createdAt: now() };
    patchThread(threadId, (current) => ({ ...current, messages: [...current.messages, assistant], updatedAt: now(), running: true }));
    return assistant;
  };

  const updateAssistant = (threadId: string, updater: (message: TaoMessage) => TaoMessage) => {
    patchThread(threadId, (thread) => {
      let index = -1;
      for (let cursor = thread.messages.length - 1; cursor >= 0; cursor -= 1) {
        if (thread.messages[cursor].role === "assistant") { index = cursor; break; }
      }
      if (index < 0) return thread;
      const messages = [...thread.messages];
      messages[index] = updater(messages[index]);
      return { ...thread, messages, updatedAt: now() };
    });
  };

  const appendBlockDelta = (threadId: string, event: Extract<TaoEvent, { type: "block_delta" }>) => {
    updateAssistant(threadId, (message) => {
      const blocks = [...message.blocks];
      const current = blocks[event.index] ?? { id: id("tao-block"), type: "text" as const, text: "" };
      const next = {
        ...current,
        text: `${current.text ?? ""}${event.delta.text ?? ""}`,
        query: event.delta.query ?? current.query,
        status: event.delta.status ?? current.status,
        sources: event.delta.sources ? [...(current.sources ?? []), ...event.delta.sources] : current.sources,
        rawDeltas: event.rawDelta ? [...(current.rawDeltas ?? []), event.rawDelta] : current.rawDeltas,
      };
      blocks[event.index] = next;
      return { ...message, text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""), blocks };
    });
  };

  const processEvent = (threadId: string, event: TaoEvent) => {
    if (!state.threads[threadId]) return;
    if (event.type === "block_start" || event.type === "block_delta" || event.type === "block_stop") event = { ...event, index: event.index + (blockOffsets.get(threadId) ?? 0) };
    if (event.type === "message_start") {
      updateAssistant(threadId, (message) => ({ ...message, stopReason: undefined }));
      const ledger = usageCalls.get(threadId) ?? { current: "", calls: new Map<string, Partial<TaoUsage>>() };
      ledger.current = event.messageId ?? id("call");
      usageCalls.set(threadId, ledger);
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "streaming" }));
      if (event.usage) processEvent(threadId, { type: "message_delta", usage: event.usage });
      return;
    }
    if (event.type === "block_start") {
      updateAssistant(threadId, (message) => {
        const blocks = [...message.blocks];
        const block: TaoBlock = { id: id("tao-block"), ...event.block, type: event.block.type, rawBlock: event.rawBlock };
        blocks[event.index] = block;
        return { ...message, blocks };
      });
      if (event.block.type === "thinking") patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "thinking" }));
      if (event.block.type === "search") patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "searching" }));
      return;
    }
    if (event.type === "block_delta") {
      appendBlockDelta(threadId, event);
      return;
    }
    if (event.type === "block_stop") {
      updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block, index) => index === event.index ? { ...block, status: "complete" } : block) }));
      return;
    }
    if (event.type === "message_delta") {
      if (event.stopReason) updateAssistant(threadId, (message) => ({ ...message, stopReason: event.stopReason }));
      if (event.stopReason === "max_tokens") patchRuntime(threadId, (runtime) => ({ ...runtime, phase: ["vault_locked", "error", "budget_halt"].includes(runtime.phase) ? runtime.phase : "stopped" }));
      if (event.stopReason === "refusal") {
        updateAssistant(threadId, (message) => ({ ...message, text: "", blocks: [...message.blocks.filter((block) => block.type !== "thinking" && block.type !== "text" && block.type !== "error"), { id: id("tao-refusal"), type: "error", error: { category: "configuration", message: "安全校验未通过本次回复" } }] }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "refusal" }));
      } else if (event.title) {
        patchThread(threadId, (thread) => ({ ...thread, title: event.title ?? thread.title }));
      }
      const ledger = usageCalls.get(threadId) ?? { current: "default", calls: new Map<string, Partial<TaoUsage>>() };
      if (event.usage) { ledger.calls.set(ledger.current, { ...ledger.calls.get(ledger.current), ...event.usage }); usageCalls.set(threadId, ledger); }
      const totals = [...ledger.calls.values()].reduce<{ inputTokens: number; outputTokens: number }>((sum, call) => ({ inputTokens: sum.inputTokens + (call.inputTokens ?? 0), outputTokens: sum.outputTokens + (call.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
      const applied = usageApplied.get(threadId) ?? 0;
      const totalTokens = totals.inputTokens + totals.outputTokens;
      const deltaTokens = Math.max(0, totalTokens - applied);
      usageApplied.set(threadId, totalTokens);
      const usage = mergeUsage(state.runtime[threadId]?.budget, event.usage ? { inputTokens: deltaTokens, outputTokens: 0 } : undefined);
      if (usage) {
        patchRuntime(threadId, (runtime) => ({ ...runtime, budget: usage, phase: usage.halted ? "budget_halt" : runtime.phase }));
        if (usage.halted) { running.get(threadId)?.abort(); void options.backend?.stop?.(threadId).catch(() => undefined); }
        if (event.usage) {
          updateAssistant(threadId, (message) => ({
            ...message,
            blocks: [
              ...message.blocks.filter((block) => block.id !== `usage:${ledger.current}`),
              { id: `usage:${ledger.current}`, type: "usage", usage: { inputTokens: ledger.calls.get(ledger.current)?.inputTokens ?? 0, outputTokens: ledger.calls.get(ledger.current)?.outputTokens ?? 0, searchCalls: ledger.calls.get(ledger.current)?.searchCalls ?? 0, fetchCalls: ledger.calls.get(ledger.current)?.fetchCalls ?? 0, estimatedCostCny: event.usage?.estimatedCostCny, priceAsOf: event.usage?.priceAsOf } },
            ],
          }));
        }
      }
      return;
    }
    if (event.type === "error") {
      updateAssistant(threadId, (message) => ({ ...message, blocks: [...message.blocks.filter((block) => block.type !== "error"), { id: id("tao-error"), type: "error", error: { category: event.category, message: event.message } }] }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: event.category === "vault_locked" ? "vault_locked" : "error", vaultPromptDismissed: false }));
      return;
    }
    if (event.type === "message_stop") {
      updateAssistant(threadId, (message) => completeReply(message, state.runtime[threadId]?.lastRequest?.mode === "do", () => id("proposal")));
      const actions = state.threads[threadId]?.messages.at(-1)?.blocks.filter((block) => block.type === "action" && block.action).map((block) => block.action!);
      patchThread(threadId, (thread) => ({ ...thread, running: false }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: runtime.phase === "vault_locked" ? "vault_locked" : runtime.budget.halted ? "budget_halt" : ["refusal", "error", "stopped"].includes(runtime.phase) ? runtime.phase : actions?.length ? "awaiting_action" : "idle" }));
    }
  };

  const controller: TaoChatController = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getState() { return state; },
    recordHandoff(threadId, handoff) { patchThread(threadId, (thread) => ({ ...thread, updatedAt: now(), handoffs: [...(thread.handoffs ?? []).filter((item) => item.targetThreadId !== handoff.targetThreadId), handoff] })); },
    setMode(mode) { patch({ mode, composer: { ...state.composer, thinking: state.composer.capabilities?.thinking !== false && mode !== "ask", web: state.composer.capabilities?.web !== false && mode === "research" } }); },
    setComposerText(text) { patch({ composer: { ...state.composer, text } }); },
    setComposerOption(option, value) { if (value && state.composer.capabilities?.[option] === false) return; patch({ composer: { ...state.composer, [option]: value } }); },
    setModel(model, options) {
      const composer = state.composer;
      patch({ composer: { ...composer, model, ...(options && { capabilities: { thinking: options.thinking, web: options.web }, thinking: composer.thinking && options.thinking, web: composer.web && options.web, reasoningEffort: options.reasoningEffort }) } });
    },
    setProvider(provider, options) {
      const capabilities = { thinking: options?.thinking ?? ["deepseek-app", "opencode-go"].includes(provider), web: options?.web ?? ["deepseek-app", "opencode-go"].includes(provider) };
      patch({ composer: { ...state.composer, provider, model: options?.model ?? (provider === "opencode-go" ? "deepseek-v4.1-flash" : provider === "deepseek-app" ? "deepseek-flash" : ""), capabilities, reasoningEffort: options?.reasoningEffort ?? state.composer.reasoningEffort, thinking: capabilities.thinking && state.composer.thinking, web: capabilities.web && state.composer.web, chips: state.composer.chips.filter((chip) => !chip.fileId || (chip.provider ?? "deepseek-app") === provider) } });
    },
    setReasoningEffort(reasoningEffort) { patch({ composer: { ...state.composer, reasoningEffort } }); },
    setContext(context) { patch({ context }); },
    setChips(chips) { patch({ composer: { ...state.composer, chips } }); },
    setSidePanel(panel) { patch({ ui: { ...state.ui, sidePanel: panel } }); },
    setDemoMode(enabled) { patch({ ui: { ...state.ui, demoMode: enabled } }); },
    setSearchOpen(open) { patch({ ui: { ...state.ui, searchOpen: open } }); },
    createThread(title = tr("新 Tao 对话")) {
      const threadId = id("tao-thread");
      patch({
        activeThreadId: threadId,
        threads: { ...state.threads, [threadId]: { id: threadId, title, messages: [], updatedAt: now(), source: "tao" } },
        runtime: { ...state.runtime, [threadId]: { phase: "idle", budget: { usedTokens: 0, limitTokens: budget.limitTokens, halted: false } } },
        mode: "ask",
        composer: { ...state.composer, text: "", chips: [], model: profile.defaultModel ?? "deepseek-flash", provider: profile.defaultProvider ?? "deepseek-app", reasoningEffort: profile.defaultReasoningEffort ?? "high", capabilities: profile.defaultCapabilities, thinking: profile.defaultThinking ?? false, web: profile.defaultWeb ?? false },
        context: {},
      });
      return threadId;
    },
    async deleteThread(threadId, persist) {
      const thread = state.threads[threadId];
      if (!thread || running.has(threadId) || thread.running || state.runtime[threadId]?.deleting || state.runtime[threadId]?.actionBusy || thread.messages.some((message) => message.blocks.some((block) => block.action?.status === "approved"))) return false;
      patchRuntime(threadId, (runtime) => ({ ...runtime, deleting: true }));
      try {
        await persist?.(thread);
      } catch (error) {
        patchRuntime(threadId, (runtime) => ({ ...runtime, deleting: false }));
        throw error;
      }
      const threads = { ...state.threads };
      const runtime = { ...state.runtime };
      delete threads[threadId]; delete runtime[threadId];
      usageCalls.delete(threadId); usageApplied.delete(threadId); blockOffsets.delete(threadId);
      const active = state.activeThreadId === threadId;
      patch({ threads, runtime, ...(active ? { activeThreadId: null } : {}) });
      if (active) {
        const next = Object.values(threads).filter((item) => item.source !== "legacy").sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) controller.setActiveThread(next.id);
        else controller.createThread();
      }
      return true;
    },
    setActiveThread(threadId) {
      if (!state.threads[threadId]) return;
      const preferences = state.threads[threadId].preferences;
      const composer = preferences?.composer ? { ...preferences.composer, provider: preferences.composer.provider ?? "deepseek-app" as const, reasoningEffort: preferences.composer.reasoningEffort ?? "high" as const } : { ...state.composer, text: "", chips: [] };
      patch({ activeThreadId: threadId, mode: preferences?.mode ?? "ask", context: preferences?.context ?? {}, composer });
    },
    async send(content) {
      const threadId = state.activeThreadId ?? controller.createThread();
      const text = (content ?? state.composer.text).trim();
      const runtime = state.runtime[threadId] ?? activeRuntime();
      if (!text || !options.backend || runtime?.deleting || runtime?.phase === "vault_locked" || runtime?.phase === "sending" || runtime?.phase === "streaming" || runtime?.phase === "thinking" || runtime?.phase === "searching" || runtime?.phase === "awaiting_action" || runtime?.phase === "plan_pending" || runtime?.phase === "budget_halt") return false;
      if (state.threads[threadId].messages.some((m) => m.blocks.some((b) => b.action && actionPending(b.action)))) return false;
      const actionFeedback = state.threads[threadId].messages.flatMap((message) => message.blocks.flatMap((block) => block.action && !actionPending(block.action) ? [{ id: actionKey(block.action), title: block.action.title, status: block.action.status!, result: block.action.result }] : [])).slice(-20);
      const request: TaoRequest = { threadId, content: text, mode: state.mode, model: state.composer.model, provider: state.composer.provider ?? "deepseek-app", reasoningEffort: state.composer.reasoningEffort ?? "high", thinking: state.composer.thinking, web: state.composer.web, context: state.context, chips: state.composer.chips, actionFeedback };
      const user: TaoMessage = { id: id("tao-user"), role: "user", text, blocks: [], createdAt: now() };
      patchThread(threadId, (thread) => ({ ...thread, messages: [...thread.messages, user], title: thread.messages.length === 0 ? text.slice(0, 48) : thread.title, updatedAt: now(), running: true }));
      ensureAssistant(threadId);
      patch({ composer: { ...state.composer, text: "" } });
      const abortController = new AbortController();
      usageCalls.delete(threadId); usageApplied.delete(threadId); blockOffsets.delete(threadId);
      running.set(threadId, abortController);
      patchRuntime(threadId, (current) => ({ ...current, phase: "sending", startedAt: now(), finishedAt: undefined, budget: { ...current.budget, usedTokens: 0, halted: false }, lastRequest: { web: request.web, mode: request.mode, model: request.model, provider: request.provider, reasoningEffort: request.reasoningEffort, thinking: request.thinking, chips: request.chips, context: request.context } }));
      try {
        const events = await options.backend.send(request, abortController.signal);
        for await (const event of asArray(events)) {
          if (abortController.signal.aborted) break;
          processEvent(threadId, event);
        }
        const phase = state.runtime[threadId]?.phase;
        if (phase === "sending" || phase === "streaming" || phase === "thinking" || phase === "searching") patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle" }));
      } catch (error) {
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: classifyError(error), message: String(error) });
      } finally {
        // The backend settles its snapshot after the final stream event. Stamp
        // completion so its newer timestamp cannot reject our UI preferences.
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false, updatedAt: now() }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now() }));
      }
      return true;
    },
    async stop() {
      const threadId = state.activeThreadId;
      if (threadId) {
        running.get(threadId)?.abort();
        try { await options.backend?.stop?.(threadId); } catch { /* local abort still makes stop deterministic */ }
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: runtime.phase === "vault_locked" ? "vault_locked" : "stopped" }));
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
      }
    },
    acknowledgeVaultUnlock(threadId) {
      if (state.runtime[threadId]?.phase !== "vault_locked" || running.has(threadId)) return;
      updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.filter((block) => block.error?.category !== "vault_locked") }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "stopped" }));
    },
    dismissVaultPrompt(threadId) {
      if (state.runtime[threadId]?.phase === "vault_locked") patchRuntime(threadId, (runtime) => ({ ...runtime, vaultPromptDismissed: true }));
    },
    async continueReply() {
      const threadId = state.activeThreadId;
      if (!threadId || !options.backend?.continue) return false;
      const runtime = state.runtime[threadId];
      if (runtime?.deleting || runtime?.phase === "vault_locked" || runtime?.lastRequest?.web || running.has(threadId)) return false;
      if (state.threads[threadId].messages.some((m) => m.blocks.some((b) => b.action && actionPending(b.action)))) return false;
      const abortController = new AbortController();
      updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.filter((block) => block.type !== "error") }));
      blockOffsets.set(threadId, state.threads[threadId].messages.at(-1)?.blocks.length ?? 0);
      running.set(threadId, abortController);
      patchRuntime(threadId, (current) => ({ ...current, phase: "streaming", startedAt: now(), finishedAt: undefined }));
      try {
        const events = await options.backend.continue(threadId);
        for await (const event of asArray(events)) {
          if (abortController.signal.aborted) break;
          processEvent(threadId, event);
        }
        return true;
      } catch (error) {
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: classifyError(error), message: String(error) });
        return false;
      } finally {
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false, updatedAt: now() }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: ["sending", "streaming", "thinking", "searching"].includes(runtime.phase) ? "idle" : runtime.phase }));
      }
    },
    async regenerate() {
      const threadId = state.activeThreadId;
      if (!threadId || !options.backend?.regenerate) return false;
      if (state.runtime[threadId]?.deleting || state.runtime[threadId]?.phase === "vault_locked" || running.has(threadId)) return false;
      if (state.threads[threadId].messages.some((m) => m.blocks.some((b) => b.action && actionPending(b.action)))) return false;
      const abortController = new AbortController();
      blockOffsets.delete(threadId); usageCalls.delete(threadId); usageApplied.delete(threadId);
      ensureAssistant(threadId);
      updateAssistant(threadId, (message) => ({ ...message, text: "", blocks: [] }));
      running.set(threadId, abortController);
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "sending", startedAt: now(), finishedAt: undefined, budget: { ...runtime.budget, usedTokens: 0, halted: false } }));
      try {
        const events = await options.backend.regenerate(threadId);
        ensureAssistant(threadId);
        for await (const event of asArray(events)) {
          if (abortController.signal.aborted) break;
          processEvent(threadId, event);
        }
        return true;
      } catch (error) {
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: classifyError(error), message: String(error) });
        return false;
      } finally {
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false, updatedAt: now() }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: ["sending", "streaming", "thinking", "searching"].includes(runtime.phase) ? "idle" : runtime.phase }));
      }
    },
    ...createActionLifecycle({ getState: () => state, patchThread, patchRuntime, ports: options.actionPorts }),
    removeChip(chipId) { patch({ composer: { ...state.composer, chips: state.composer.chips.filter((chip) => chip.id !== chipId) } }); },
    hydrateThreads(threads, options) {
      const valid = threads.filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.messages));
      if (!valid.length) {
        if (options?.merge) patch({ threads: Object.fromEntries(Object.entries(state.threads).filter(([, thread]) => thread.source !== "legacy")) });
        return;
      }
      const ordered = [...valid].sort((a, b) => b.updatedAt - a.updatedAt).map((thread) => ({ ...thread, messages: thread.messages.map((message) => ({ ...message, blocks: (message.blocks ?? []).map((block) => block.action?.status === "approved" ? { ...block, action: { ...block.action, status: "invalid" as const, result: { output: tr("执行已中断，请检查实际结果后重新提议。") } } } : block) })) }));
      const runtime = Object.fromEntries(ordered.map((thread) => [thread.id, { phase: thread.messages.at(-1)?.stopReason === "max_tokens" ? "stopped" as const : thread.messages.some((m) => m.blocks.some((b) => b.action && actionPending(b.action))) ? "awaiting_action" as const : "idle" as const, budget: { usedTokens: 0, limitTokens: budget.limitTokens, halted: false } }]));
      const incoming = Object.fromEntries(ordered.map((thread) => [thread.id, { ...thread, running: false }]));
      if (options?.merge) {
        // Refresh legacy summaries from their owner, while current Home threads
        // retain drafts, active streams, action approvals and cancellation owners.
        const current = Object.fromEntries(Object.entries(state.threads).filter(([, thread]) => thread.source !== "legacy"));
        patch({ threads: { ...incoming, ...current }, runtime: { ...runtime, ...state.runtime } });
        return;
      }
      const active = ordered.find((thread) => thread.source !== "legacy");
      if (!active) {
        patch({ threads: { ...incoming, ...state.threads }, runtime: { ...runtime, ...state.runtime } });
        return;
      }
      patch({ threads: incoming, runtime, activeThreadId: active.id });
      controller.setActiveThread(active.id);
    },
    increaseBudget(limitTokens) {
      const threadId = state.activeThreadId;
      if (!threadId || !Number.isFinite(limitTokens) || limitTokens <= state.runtime[threadId].budget.limitTokens) return;
      patchRuntime(threadId, (runtime) => ({ ...runtime, budget: { ...runtime.budget, limitTokens, halted: false } }));
    },
    setDefaults(defaults) {
      Object.assign(profile, defaults);
      const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
      // Config loads asynchronously. Initialize a pristine conversation, while
      // preserving existing threads and user choices when settings change.
      if (thread && !thread.messages.length && !thread.preferences && !state.composer.text) {
        patch({ composer: { ...state.composer, model: defaults.defaultModel, provider: defaults.defaultProvider ?? "deepseek-app", reasoningEffort: defaults.defaultReasoningEffort ?? "high", capabilities: defaults.defaultCapabilities, thinking: defaults.defaultThinking, web: defaults.defaultWeb } });
      }
    },
    branchAt(messageId, replacement) {
      const source = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
      const index = source?.messages.findIndex((message) => message.id === messageId) ?? -1;
      if (!source || index < 0 || running.has(source.id) || state.runtime[source.id]?.deleting) return undefined;
      const threadId = controller.createThread(`${source.title} · ${tr("分支")}`);
      const messages = source.messages.slice(0, replacement === undefined ? index + 1 : index);
      patchThread(threadId, (thread) => ({ ...thread, messages: structuredClone(messages), preferences: source.preferences }));
      void options.backend?.clone?.(source.id, threadId, index).catch(() => undefined);
      if (source.preferences) { patch({ mode: source.preferences.mode, context: { ...source.preferences.context }, composer: { ...source.preferences.composer, text: replacement ?? "" } }); }
      else if (replacement !== undefined) controller.setComposerText(replacement);
      return threadId;
    },
  };
  return controller;
}

export function controllerBudgetWarning(controller: TaoChatController): 50 | 80 | undefined {
  const runtime = controller.getState().activeThreadId ? controller.getState().runtime[controller.getState().activeThreadId!] : undefined;
  return runtime ? getBudgetWarning(runtime.budget.usedTokens, runtime.budget.limitTokens) : undefined;
}
