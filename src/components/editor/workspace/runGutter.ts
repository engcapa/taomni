/**
 * ED-PARITY-022 DEC-022-03: IDEA run gutter icons. A green ▶ appears only on
 * lines the workspace has real run facts for (a detected run configuration of
 * this file); without facts the gutter stays empty instead of guessing.
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

export interface RunGutterTarget {
  /** Zero-based document line. */
  line: number;
  label: string;
}

export interface RunGutterConfig {
  targets: readonly RunGutterTarget[];
  onClick?: (target: RunGutterTarget, anchor: { x: number; y: number }) => void;
}

const EMPTY: RunGutterConfig = { targets: [] };

export const setRunGutter = StateEffect.define<RunGutterConfig>();

const runGutterField = StateField.define<RunGutterConfig>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRunGutter)) return effect.value;
    }
    return value;
  },
});

class RunGutterMarker extends GutterMarker {
  constructor(
    readonly target: RunGutterTarget,
    readonly onClick?: RunGutterConfig["onClick"],
  ) {
    super();
  }

  eq(other: RunGutterMarker): boolean {
    return other.target.line === this.target.line
      && other.target.label === this.target.label
      && other.onClick === this.onClick;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.className = "cm-run-gutter-marker";
    button.textContent = "▶";
    button.setAttribute("data-testid", "code-workspace-run-gutter");
    button.setAttribute("data-line", String(this.target.line + 1));
    button.setAttribute("aria-label", `Run ${this.target.label}`);
    button.title = `Run ${this.target.label}`;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = button.getBoundingClientRect();
      this.onClick?.(this.target, { x: Math.round(rect.right), y: Math.round(rect.bottom) });
    });
    return button;
  }
}

/**
 * Lines of `main` entry points in Java text, plus the enclosing top-level
 * type declaration (IDEA marks both). Only used together with real run facts.
 */
export function javaMainRunLines(text: string): { classLine: number | null; mainLine: number | null } {
  const lines = text.split("\n");
  let classLine: number | null = null;
  let mainLine: number | null = null;
  lines.forEach((line, index) => {
    if (classLine === null && /^\s*(?:public\s+)?(?:final\s+|abstract\s+)*(?:class|record|enum|interface)\s+[A-Za-z_$]/.test(line)) {
      classLine = index;
    }
    if (mainLine === null && /\bstatic\s+void\s+main\s*\(/.test(line)) mainLine = index;
  });
  return { classLine, mainLine };
}

const runGutterTheme = EditorView.baseTheme({
  // No fixed width: without run facts the column collapses to nothing.
  ".cm-run-gutter .cm-gutterElement": { padding: "0", display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-run-gutter-marker": {
    border: "0",
    padding: "0",
    background: "transparent",
    color: "var(--taomni-code-run, #3fb950)",
    fontSize: "9px",
    lineHeight: "1",
    width: "12px",
    cursor: "pointer",
  },
});

export function createRunGutter(config: RunGutterConfig = EMPTY): Extension[] {
  return [
    runGutterField.init(() => config),
    gutter({
      class: "cm-run-gutter",
      markers: (view) => {
        const { targets, onClick } = view.state.field(runGutterField);
        const builder = new RangeSetBuilder<GutterMarker>();
        const sorted = [...targets].sort((a, b) => a.line - b.line);
        for (const target of sorted) {
          if (target.line < 0 || target.line >= view.state.doc.lines) continue;
          const line = view.state.doc.line(target.line + 1);
          builder.add(line.from, line.from, new RunGutterMarker(target, onClick));
        }
        return builder.finish();
      },
    }),
    runGutterTheme,
  ];
}
