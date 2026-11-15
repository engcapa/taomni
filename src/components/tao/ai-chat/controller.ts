import { taoText as tr } from "../i18n";
import { parseActionProposals, validateActionProposal } from "../actions";
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

const DEFAULT_BUDGET: BudgetPort = { limitTokens: 10_000_000, costConfirmThresholdCny: 0.5 };

function id(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return Date.now();
}

function classifyError(error: unknown): "protocol" | "http" | "network" {
  const text = String(error).toLowerCase();
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
  const profile: Partial<ChatProfile> = options.profile ?? {};
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
    if (event.type === "block_start" || event.type === "block_delta" || event.type === "block_stop") event = { ...event, index: event.index + (blockOffsets.get(threadId) ?? 0) };
    if (event.type === "message_start") {
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
        if (usage.halted) running.get(threadId)?.abort();
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
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: event.category === "vault_locked" ? "vault_locked" : "error" }));
      return;
    }
    if (event.type === "message_stop") {
      updateAssistant(threadId, (message) => {
        const actionBlocks = parseActionProposals(message.text);
        const blocks = actionBlocks.length > 0
          ? [...message.blocks.filter((block) => block.type !== "action"), ...actionBlocks.slice(0, 5).map((action) => ({ id: id("tao-action"), type: "action" as const, action }))]
          : message.blocks;
        return { ...message, text: message.text.replace(/```tao-action[\s\S]*?```/g, "").trim(), blocks };
      });
      const actions = state.threads[threadId]?.messages.at(-1)?.blocks.filter((block) => block.type === "action" && block.action).map((block) => block.action!);
      patchThread(threadId, (thread) => ({ ...thread, running: false }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: runtime.budget.halted ? "budget_halt" : runtime.phase === "refusal" || runtime.phase === "error" ? runtime.phase : actions?.length ? "awaiting_action" : "idle" }));
    }
  };

  const controller: TaoChatController = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getState() { return state; },
    setMode(mode) { patch({ mode, composer: { ...state.composer, thinking: mode !== "ask", web: mode === "research" } }); },
    setComposerText(text) { patch({ composer: { ...state.composer, text } }); },
    setComposerOption(option, value) { patch({ composer: { ...state.composer, [option]: value } }); },
    setModel(model) { patch({ composer: { ...state.composer, model } }); },
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
        composer: { ...state.composer, text: "", chips: [], model: profile.defaultModel ?? "deepseek-flash", thinking: profile.defaultThinking ?? false, web: profile.defaultWeb ?? false },
        context: {},
      });
      return threadId;
    },
    setActiveThread(threadId) {
      if (!state.threads[threadId]) return;
      const preferences = state.threads[threadId].preferences;
      patch({ activeThreadId: threadId, mode: preferences?.mode ?? "ask", context: preferences?.context ?? {}, composer: preferences?.composer ?? { ...state.composer, text: "", chips: [] } });
    },
    async send(content) {
      const threadId = state.activeThreadId ?? controller.createThread();
      const text = (content ?? state.composer.text).trim();
      const runtime = state.runtime[threadId] ?? activeRuntime();
      if (!text || !options.backend || runtime?.phase === "sending" || runtime?.phase === "streaming" || runtime?.phase === "thinking" || runtime?.phase === "searching" || runtime?.phase === "awaiting_action" || runtime?.phase === "plan_pending" || runtime?.phase === "budget_halt") return false;
      const request: TaoRequest = { threadId, content: text, mode: state.mode, model: state.composer.model, thinking: state.composer.thinking, web: state.composer.web, context: state.context, chips: state.composer.chips };
      const user: TaoMessage = { id: id("tao-user"), role: "user", text, blocks: [], createdAt: now() };
      patchThread(threadId, (thread) => ({ ...thread, messages: [...thread.messages, user], title: thread.messages.length === 0 ? text.slice(0, 48) : thread.title, updatedAt: now(), running: true }));
      ensureAssistant(threadId);
      patch({ composer: { ...state.composer, text: "" } });
      const abortController = new AbortController();
      usageCalls.delete(threadId); usageApplied.delete(threadId); blockOffsets.delete(threadId);
      running.set(threadId, abortController);
      patchRuntime(threadId, (current) => ({ ...current, phase: "sending", startedAt: now(), finishedAt: undefined, budget: { ...current.budget, usedTokens: 0, halted: false }, lastRequest: { web: request.web, mode: request.mode, model: request.model, thinking: request.thinking, chips: request.chips, context: request.context } }));
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
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now() }));
      }
      return true;
    },
    async stop() {
      const threadId = state.activeThreadId;
      if (threadId) {
        running.get(threadId)?.abort();
        try { await options.backend?.stop?.(threadId); } catch { /* local abort still makes stop deterministic */ }
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "stopped" }));
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
      }
    },
    async continueReply() {
      const threadId = state.activeThreadId;
      if (!threadId || !options.backend?.continue) return false;
      const runtime = state.runtime[threadId];
      if (runtime?.lastRequest?.web || running.has(threadId)) return false;
      const abortController = new AbortController();
      blockOffsets.set(threadId, state.threads[threadId].messages.at(-1)?.blocks.length ?? 0);
      updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.filter((block) => block.type !== "error") }));
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
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: "network", message: String(error) });
        return false;
      } finally {
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: ["sending", "streaming", "thinking", "searching"].includes(runtime.phase) ? "idle" : runtime.phase }));
      }
    },
    async regenerate() {
      const threadId = state.activeThreadId;
      if (!threadId || !options.backend?.regenerate) return false;
      if (running.has(threadId)) return false;
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
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: "network", message: String(error) });
        return false;
      } finally {
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, finishedAt: now(), phase: ["sending", "streaming", "thinking", "searching"].includes(runtime.phase) ? "idle" : runtime.phase }));
      }
    },
    async approveAction(action) {
      const threadId = state.activeThreadId;
      if (!threadId) return;
      const checked = validateActionProposal(action, state.context);
      if (!checked.ok) {
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "error", pendingAction: { ...action, status: "invalid" } }));
        return;
      }
      if (!options.actionPorts?.execute) {
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...checked.action, status: "invalid", result: { output: tr("当前宿主没有提供动作执行器。") } } } : block) }));
        return;
      }
      try {
        const result = await options.actionPorts.execute(checked.action, threadId);
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...checked.action, status: result?.exitCode && result.exitCode !== 0 ? "invalid" : "completed", result } } : block) }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle", pendingAction: undefined }));
      } catch (error) {
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...checked.action, status: "invalid", result: { output: String(error) } } } : block) }));
      }
    },
    async rejectAction(action) {
      await options.actionPorts?.reject?.(action);
      const threadId = state.activeThreadId;
      if (threadId) {
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...action, status: "rejected" } } : block) }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle", pendingAction: undefined }));
      }
    },
    async undoAction(action) {
      const threadId = state.activeThreadId;
      if (!threadId || !options.actionPorts?.undo) return;
      try {
        await options.actionPorts.undo(action, threadId);
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...action, status: "undone", result: { ...action.result, output: tr("已撤销") } } } : block) }));
      } catch (error) {
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...action, result: { ...action.result, output: String(error) } } } : block) }));
      }
    },
    removeChip(chipId) { patch({ composer: { ...state.composer, chips: state.composer.chips.filter((chip) => chip.id !== chipId) } }); },
    hydrateThreads(threads) {
      const valid = threads.filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.messages));
      if (!valid.length) return;
      const ordered = [...valid].sort((a, b) => b.updatedAt - a.updatedAt);
      const runtime = Object.fromEntries(ordered.map((thread) => [thread.id, { phase: "idle" as const, budget: { usedTokens: 0, limitTokens: budget.limitTokens, halted: false } }]));
      patch({ threads: Object.fromEntries(ordered.map((thread) => [thread.id, { ...thread, running: false }])), runtime, activeThreadId: ordered[0].id });
      controller.setActiveThread(ordered[0].id);
    },
    increaseBudget(limitTokens) {
      const threadId = state.activeThreadId;
      if (!threadId || !Number.isFinite(limitTokens) || limitTokens <= state.runtime[threadId].budget.limitTokens) return;
      patchRuntime(threadId, (runtime) => ({ ...runtime, budget: { ...runtime.budget, limitTokens, halted: false } }));
    },
    setDefaults(defaults) { Object.assign(profile, defaults); },
    branchAt(messageId, replacement) {
      const source = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
      const index = source?.messages.findIndex((message) => message.id === messageId) ?? -1;
      if (!source || index < 0 || running.has(source.id)) return undefined;
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
