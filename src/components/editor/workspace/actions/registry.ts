import {
  type WorkspaceActionDefinition,
  type ActionRegistryEvent,
  type ActionCategory,
  type WorkspaceActionContext,
  type ActionState,
  type ActionResult,
} from "./types";
import { compileWhenExpr } from "./conditions";

export class ActionRegistry {
  private actions = new Map<string, WorkspaceActionDefinition>();
  private actionStacks = new Map<string, WorkspaceActionDefinition[]>();
  private aliases = new Map<string, string>();
  private listeners = new Set<(event: ActionRegistryEvent) => void>();

  constructor() {
    this.setupDefaultAliases();
  }

  private setupDefaultAliases(): void {
    this.aliases.set("workspace.formatDocument", "workspace.format");
    this.aliases.set("workspace.nextDiagnostic", "workspace.nextError");
    this.aliases.set("workspace.prevDiagnostic", "workspace.prevError");
    this.aliases.set("workspace.quickDefinitionPeek", "workspace.quickDefinition");
    this.aliases.set("workspace.rename", "workspace.renameSymbol");
    this.aliases.set("workspace.safeDelete", "workspace.safeDeleteSymbol");
  }

  registerAlias(aliasId: string, targetId: string): void {
    this.aliases.set(aliasId, targetId);
  }

  resolveId(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  register(action: WorkspaceActionDefinition): () => void {
    const resolvedId = action.id;
    let stack = this.actionStacks.get(resolvedId);
    if (!stack) {
      stack = [];
      this.actionStacks.set(resolvedId, stack);
    }
    stack.push(action);
    this.actions.set(resolvedId, action);
    this.notify({ type: "registered", actionId: resolvedId });
    return () => {
      const currentStack = this.actionStacks.get(resolvedId);
      if (currentStack) {
        const index = currentStack.indexOf(action);
        if (index !== -1) {
          currentStack.splice(index, 1);
        }
        if (currentStack.length > 0) {
          const restored = currentStack[currentStack.length - 1];
          this.actions.set(resolvedId, restored);
          this.notify({ type: "registered", actionId: resolvedId });
          this.notify({ type: "state-changed", actionId: resolvedId });
        } else {
          this.actionStacks.delete(resolvedId);
          this.actions.delete(resolvedId);
          this.notify({ type: "unregistered", actionId: resolvedId });
        }
      } else if (this.actions.get(resolvedId) === action) {
        this.actions.delete(resolvedId);
        this.notify({ type: "unregistered", actionId: resolvedId });
      }
    };
  }

  get(id: string): WorkspaceActionDefinition | undefined {
    const resolved = this.resolveId(id);
    return this.actions.get(resolved) ?? this.actions.get(id);
  }

  getAll(): WorkspaceActionDefinition[] {
    return Array.from(this.actions.values());
  }

  getByCategory(category: ActionCategory): WorkspaceActionDefinition[] {
    return this.getAll().filter((a) => a.category === category);
  }

  getState(id: string, context: WorkspaceActionContext): ActionState {
    const action = this.get(id);
    if (!action) {
      return {
        availability: "unsupported",
        disabledReason: "unsupported",
        source: "unsupported",
        scope: "workspace",
        freshness: "unknown",
        completeness: "unavailable",
      };
    }
    if (action.getState) {
      return action.getState(context);
    }
    const compiledWhen = compileWhenExpr(action.when);
    const enabled = (action.isEnabled ? action.isEnabled(context) : true) && compiledWhen(context);
    return {
      availability: enabled ? "available" : "disabled",
      disabledReason: enabled ? undefined : (context.readOnly ? "readOnly" : (!context.hasActiveFile ? "noEditor" : "conflict")),
      source: action.provenance,
      scope: "workspace",
      freshness: "current",
      completeness: action.provenance === "unsupported" ? "unavailable" : "complete",
    };
  }

  async run(id: string, context: WorkspaceActionContext, signal?: AbortSignal): Promise<ActionResult> {
    const action = this.get(id);
    if (!action) {
      return { kind: "failed", message: `Action "${id}" not found` };
    }
    const state = this.getState(id, context);
    if (state.availability === "disabled" || state.availability === "unsupported") {
      return { kind: "no-op", message: `Action "${id}" is ${state.availability} (${state.disabledReason ?? "context blocked"})` };
    }
    try {
      this.notify({ type: "state-changed", actionId: action.id });
      const result = await action.run(context, signal);
      if (result && typeof result === "object" && "kind" in result) {
        return result;
      }
      return { kind: "applied" };
    } catch (err) {
      return {
        kind: "failed",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }

  search(query: string, context?: WorkspaceActionContext): WorkspaceActionDefinition[] {
    const q = query.trim().toLowerCase();
    const all = this.getAll();
    if (!q) {
      if (!context) return all;
      return all.filter((a) => {
        const when = compileWhenExpr(a.when);
        return when(context);
      });
    }
    return all.filter((a) => {
      const aliasTarget = this.resolveId(a.id);
      if (a.id.toLowerCase().includes(q) || aliasTarget.toLowerCase().includes(q)) return true;
      if (a.title.toLowerCase().includes(q)) return true;
      if (a.category.toLowerCase().includes(q)) return true;
      if (a.description?.toLowerCase().includes(q)) return true;
      if (a.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      const kb = typeof a.keybinding === "string" ? a.keybinding : a.keybinding?.default;
      if (kb && kb.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  subscribe(listener: (event: ActionRegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(event: ActionRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("ActionRegistry listener error:", e);
      }
    }
  }

  clear(): void {
    this.actions.clear();
    this.actionStacks.clear();
    this.setupDefaultAliases();
    this.notify({ type: "state-changed" });
  }
}

export const workspaceActionRegistry = new ActionRegistry();
