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

function defaultState(profile: Partial<ChatProfile>, budget: Partial<BudgetPort>): TaoChatState {
  const threadId = id("tao-thread");
  const thread: TaoThread = { id: threadId, title: "新 Tao 对话", messages: [], updatedAt: now(), source: "tao" };
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
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const patch = (next: Partial<TaoChatState>) => {
    state = { ...state, ...next };
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
      };
      blocks[event.index] = next;
      return { ...message, text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""), blocks };
    });
  };

  const processEvent = (threadId: string, event: TaoEvent) => {
    if (event.type === "message_start") {
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "streaming" }));
      return;
    }
    if (event.type === "block_start") {
      updateAssistant(threadId, (message) => {
        const blocks = [...message.blocks];
        const block: TaoBlock = { id: id("tao-block"), ...event.block, type: event.block.type };
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
        updateAssistant(threadId, (message) => ({ ...message, text: "", blocks: [{ id: id("tao-refusal"), type: "error", error: { category: "protocol", message: "安全校验未通过本次回复" } }] }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "refusal" }));
      } else if (event.title) {
        patchThread(threadId, (thread) => ({ ...thread, title: event.title ?? thread.title }));
      }
      const usage = mergeUsage(state.runtime[threadId]?.budget, event.usage);
      if (usage) {
        patchRuntime(threadId, (runtime) => ({ ...runtime, budget: usage, phase: usage.halted ? "budget_halt" : runtime.phase }));
        if (usage.halted) running.get(threadId)?.abort();
        if (event.usage) {
          updateAssistant(threadId, (message) => ({
            ...message,
            blocks: [
              ...message.blocks.filter((block) => block.type !== "usage"),
              { id: id("tao-usage"), type: "usage", usage: { inputTokens: event.usage?.inputTokens ?? 0, outputTokens: event.usage?.outputTokens ?? 0, searchCalls: event.usage?.searchCalls ?? 0, fetchCalls: event.usage?.fetchCalls ?? 0, estimatedCostCny: event.usage?.estimatedCostCny, priceAsOf: event.usage?.priceAsOf } },
            ],
          }));
        }
      }
      return;
    }
    if (event.type === "error") {
      updateAssistant(threadId, (message) => ({ ...message, blocks: [...message.blocks, { id: id("tao-error"), type: "error", error: { category: event.category, message: event.message } }] }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "error" }));
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
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: runtime.budget.halted ? "budget_halt" : runtime.phase === "refusal" || runtime.phase === "error" ? runtime.phase : actions?.length ? "awaiting_action" : "idle" }));
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
    createThread(title = "新 Tao 对话") {
      const threadId = id("tao-thread");
      patch({
        activeThreadId: threadId,
        threads: { ...state.threads, [threadId]: { id: threadId, title, messages: [], updatedAt: now(), source: "tao" } },
        runtime: { ...state.runtime, [threadId]: { phase: "idle", budget: { usedTokens: 0, limitTokens: budget.limitTokens, halted: false } } },
        composer: { ...state.composer, text: "", chips: [] },
      });
      return threadId;
    },
    setActiveThread(threadId) {
      if (!state.threads[threadId]) return;
      patch({ activeThreadId: threadId, composer: { ...state.composer, text: "", chips: [] } });
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
      running.set(threadId, abortController);
      patchRuntime(threadId, (current) => ({ ...current, phase: "sending", budget: { ...current.budget, halted: false }, lastRequest: { web: request.web, mode: request.mode, model: request.model, thinking: request.thinking, chips: request.chips, context: request.context } }));
      try {
        const events = await options.backend.send(request, abortController.signal);
        for await (const event of asArray(events)) {
          if (abortController.signal.aborted) break;
          processEvent(threadId, event);
        }
        const phase = state.runtime[threadId]?.phase;
        if (phase === "sending" || phase === "streaming" || phase === "thinking" || phase === "searching") patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle" }));
      } catch (error) {
        if (!abortController.signal.aborted) processEvent(threadId, { type: "error", category: "network", message: String(error) });
      } finally {
        running.delete(threadId);
        patchThread(threadId, (thread) => ({ ...thread, running: false }));
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
      running.set(threadId, abortController);
      patchRuntime(threadId, (current) => ({ ...current, phase: "streaming" }));
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
      }
    },
    async regenerate() {
      const threadId = state.activeThreadId;
      if (!threadId || !options.backend?.regenerate) return false;
      if (running.has(threadId)) return false;
      const abortController = new AbortController();
      running.set(threadId, abortController);
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "sending" }));
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
      const result = await options.actionPorts?.execute?.(checked.action);
      updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...checked.action, status: "completed", result } } : block) }));
      patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle", pendingAction: undefined }));
    },
    async rejectAction(action) {
      await options.actionPorts?.reject?.(action);
      const threadId = state.activeThreadId;
      if (threadId) {
        updateAssistant(threadId, (message) => ({ ...message, blocks: message.blocks.map((block) => block.action?.id === action.id ? { ...block, action: { ...action, status: "rejected" } } : block) }));
        patchRuntime(threadId, (runtime) => ({ ...runtime, phase: "idle", pendingAction: undefined }));
      }
    },
    removeChip(chipId) { patch({ composer: { ...state.composer, chips: state.composer.chips.filter((chip) => chip.id !== chipId) } }); },
  };
  return controller;
}

export function controllerBudgetWarning(controller: TaoChatController): 50 | 80 | undefined {
  const runtime = controller.getState().activeThreadId ? controller.getState().runtime[controller.getState().activeThreadId!] : undefined;
  return runtime ? getBudgetWarning(runtime.budget.usedTokens, runtime.budget.limitTokens) : undefined;
}
