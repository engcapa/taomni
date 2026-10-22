import { type WhenExpr, type WorkspaceActionContext } from "./types";

/**
 * Compile a structured WhenExpr, string expression, or predicate function into a runtime predicate.
 */
export function compileWhenExpr(
  when?: string | WhenExpr | ((context: WorkspaceActionContext) => boolean),
): (context: WorkspaceActionContext) => boolean {
  if (!when) return () => true;
  if (typeof when === "function") return when;
  if (typeof when === "object") {
    return evaluateWhenExpr(when);
  }

  // Parse string expression
  const str = when.trim();
  if (!str) return () => true;

  // Handle simple logical combinations: "a && b", "a || b", "!a"
  if (str.includes("&&")) {
    const parts = str.split("&&").map((p) => compileWhenExpr(p.trim()));
    return (ctx) => parts.every((p) => p(ctx));
  }
  if (str.includes("||")) {
    const parts = str.split("||").map((p) => compileWhenExpr(p.trim()));
    return (ctx) => parts.some((p) => p(ctx));
  }
  if (str.startsWith("!")) {
    const inner = compileWhenExpr(str.slice(1).trim());
    return (ctx) => !inner(ctx);
  }

  // Predefined context string aliases
  switch (str) {
    case "editorTextFocus":
    case "editorFocus":
      return (ctx) => ctx.focus === "editor";
    case "treeFocus":
      return (ctx) => ctx.focus === "tree";
    case "terminalFocus":
      return (ctx) => ctx.focus === "terminal";
    case "editorHasSelection":
    case "hasSelection":
      return (ctx) => Boolean(ctx.hasSelection);
    case "hasActiveFile":
      return (ctx) => Boolean(ctx.hasActiveFile);
    case "isDirty":
      return (ctx) => Boolean(ctx.isDirty);
    case "canUndo":
      return (ctx) => Boolean(ctx.canUndo);
    case "canRedo":
      return (ctx) => Boolean(ctx.canRedo);
    case "splitActive":
      return (ctx) => Boolean(ctx.splitActive);
    case "debugActive":
      return (ctx) => Boolean(ctx.debugActive);
    case "modalOpen":
      return (ctx) => Boolean(ctx.modalOpen);
    case "readOnly":
      return (ctx) => Boolean(ctx.readOnly);
    default:
      return (ctx) => Boolean(ctx[str]);
  }
}

export function evaluateWhenExpr(expr: WhenExpr): (context: WorkspaceActionContext) => boolean {
  switch (expr.type) {
    case "all": {
      const compiled = expr.exprs.map(evaluateWhenExpr);
      return (ctx) => compiled.every((c) => c(ctx));
    }
    case "any": {
      const compiled = expr.exprs.map(evaluateWhenExpr);
      return (ctx) => compiled.some((c) => c(ctx));
    }
    case "not": {
      const inner = evaluateWhenExpr(expr.expr);
      return (ctx) => !inner(ctx);
    }
    case "focusIs":
      return (ctx) => ctx.focus === expr.target;
    case "hasSelection":
      return (ctx) => Boolean(ctx.hasSelection);
    case "hasActiveFile":
      return (ctx) => Boolean(ctx.hasActiveFile);
    case "isDirty":
      return (ctx) => Boolean(ctx.isDirty);
    case "canUndo":
      return (ctx) => Boolean(ctx.canUndo);
    case "canRedo":
      return (ctx) => Boolean(ctx.canRedo);
    case "splitActive":
      return (ctx) => Boolean(ctx.splitActive);
    case "debugActive":
      return (ctx) => Boolean(ctx.debugActive);
    case "modalOpen":
      return (ctx) => Boolean(ctx.modalOpen);
    case "readOnly":
      return (ctx) => ctx.readOnly === (expr.value ?? true);
    case "capability":
      return (ctx) => Boolean(ctx.activeCapabilities?.[expr.name]);
    case "languageIs":
      return (ctx) => ctx.languageId === expr.languageId;
    case "custom":
      return expr.predicate;
  }
}
