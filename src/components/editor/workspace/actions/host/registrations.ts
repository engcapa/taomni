import { type WorkspaceActionContext, type WorkspaceActionDefinition } from "../types";
import { type WorkspaceCommand, type WorkspaceCommandContext } from "../../workspaceCommands";
import { type WorkspaceActionRegistrationOptions } from "./types";

export interface ActionRegistrationHostPort {
  bumpGeneration(): void;
  isDisposed(): boolean;
}

export class ActionRegistrations {
  constructor(private readonly host: ActionRegistrationHostPort) { }
  dispose(): void {
    this.actions.clear();
    this.actionLayers.clear();
    this.actionLayerBases.clear();
    this.commands.clear();
  }
  actionIds(): IterableIterator<string> { return this.actions.keys(); }
  values(): IterableIterator<WorkspaceActionDefinition> { return this.actions.values(); }

  private actions = new Map<string, WorkspaceActionDefinition>();

  /** Layered registrations let split views unmount in either order. */
  private actionLayers = new Map<string, Array<{
    token: symbol;
    action: WorkspaceActionDefinition;
    ownerViewId: string | null;
  }>>();

  private actionLayerBases = new Map<string, WorkspaceActionDefinition | undefined>();

  private commands = new Map<string, WorkspaceCommand>();

  registerAction(action: WorkspaceActionDefinition): () => void {
    if (this.host.isDisposed()) return () => { };
    const token = Symbol(`action:${action.id}`);
    this.pushActionLayer(action, token, null);
    this.host.bumpGeneration();
    return () => this.removeActionLayer(action.id, token);
  }

  registerActions(
    actions: readonly WorkspaceActionDefinition[],
    options: WorkspaceActionRegistrationOptions = {},
  ): () => void {
    if (this.host.isDisposed()) return () => { };
    const token = Symbol("actions");
    const ownerViewId = options.ownerViewId ?? null;
    for (const action of actions) this.pushActionLayer(action, token, ownerViewId);
    this.host.bumpGeneration();
    return () => {
      let changed = false;
      for (const action of actions) {
        changed = this.removeActionLayer(action.id, token, false) || changed;
      }
      if (changed) this.host.bumpGeneration();
    };
  }

  private pushActionLayer(
    action: WorkspaceActionDefinition,
    token: symbol,
    ownerViewId: string | null,
  ): void {
    let layers = this.actionLayers.get(action.id);
    if (!layers) {
      layers = [];
      this.actionLayers.set(action.id, layers);
      this.actionLayerBases.set(action.id, this.actions.get(action.id));
    }
    layers.push({ token, action, ownerViewId });
    this.actions.set(action.id, action);
  }

  actionForContext(
    actionId: string,
    context: Readonly<WorkspaceActionContext>,
  ): WorkspaceActionDefinition | undefined {
    const ownerViewId = typeof context.editorViewId === "string"
      ? context.editorViewId
      : null;
    const layers = this.actionLayers.get(actionId);
    if (!ownerViewId || !layers?.some((layer) => layer.ownerViewId !== null)) {
      return this.actions.get(actionId);
    }

    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer?.ownerViewId === ownerViewId) return layer.action;
    }
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer?.ownerViewId === null) return layer.action;
    }
    return this.actionLayerBases.get(actionId);
  }

  private removeActionLayer(actionId: string, token: symbol, bumpGeneration = true): boolean {
    const layers = this.actionLayers.get(actionId);
    if (!layers) return false;
    const index = layers.findIndex((layer) => layer.token === token);
    if (index < 0) return false;
    const wasCurrent = this.actions.get(actionId) === layers[layers.length - 1]?.action;
    layers.splice(index, 1);
    if (layers.length > 0) {
      if (wasCurrent) this.actions.set(actionId, layers[layers.length - 1]!.action);
    } else {
      this.actionLayers.delete(actionId);
      const base = this.actionLayerBases.get(actionId);
      this.actionLayerBases.delete(actionId);
      if (base) this.actions.set(actionId, base);
      else this.actions.delete(actionId);
    }
    if (bumpGeneration) this.host.bumpGeneration();
    return true;
  }

  registerCommands(commands: readonly WorkspaceCommand[]): () => void {
    if (this.host.isDisposed()) return () => { };
    const installedAdapters = new Map<string, WorkspaceActionDefinition>();

    for (const command of commands) {
      this.commands.set(command.id, command);
      if (this.actions.has(command.id)) continue;
      const adapter: WorkspaceActionDefinition = {
        id: command.id,
        title: command.title,
        category: command.category as WorkspaceActionDefinition["category"],
        keybinding: command.keybinding,
        secondaryKeybindings: command.keybindings,
        platformKeybindings: command.platformKeybindings,
        keywords: command.keywords,
        when: command.when,
        isEnabled: command.isEnabled,
        getState: command.getState,
        provenance: command.provenance ?? "local",
        run: async (context, signal) => {
          if (signal?.aborted) {
            return {
              kind: "cancelled",
              reason: "aborted",
              message: "Command cancelled via AbortSignal.",
            };
          }
          try {
            const result = await Promise.resolve(command.run(context as WorkspaceCommandContext));
            if (signal?.aborted) {
              return {
                kind: "cancelled",
                reason: "aborted",
                message: "Command cancelled after execution.",
              };
            }
            return (result as unknown) !== false
              ? { kind: "applied" }
              : { kind: "no-op", reason: "condition-not-met" };
          } catch (error) {
            return {
              kind: "failed",
              reason: "exception",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
      };
      installedAdapters.set(command.id, adapter);
      this.actions.set(command.id, adapter);
    }
    this.host.bumpGeneration();

    return () => {
      let changed = false;
      for (const command of commands) {
        if (this.commands.get(command.id) === command) {
          this.commands.delete(command.id);
          changed = true;
        }
        const adapter = installedAdapters.get(command.id);
        if (adapter && this.actions.get(command.id) === adapter) {
          this.actions.delete(command.id);
          changed = true;
        }
      }
      if (changed) this.host.bumpGeneration();
    };
  }

  getAction(id: string): WorkspaceActionDefinition | undefined {
    return this.actions.get(id);
  }
}
