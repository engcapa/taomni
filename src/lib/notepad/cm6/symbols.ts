import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { NotepadSymbolFlags } from "../../../stores/notepadStore";

export interface SymbolRenderConfig extends NotepadSymbolFlags {
  eolLabel: "LF" | "CRLF" | "CR";
  showRuler: boolean;
  rulerCol: number;
  tabSize: number;
}

export const setSymbolConfigEffect = StateEffect.define<SymbolRenderConfig>();

/**
 * Renders EOL/control markers via data-* + CSS ::after so `.cm-line.textContent`
 * stays strictly equal to the underlying buffer text (preserves line assertions).
 */
class PseudoSymbolWidget extends WidgetType {
  constructor(
    private readonly className: string,
    private readonly badgeText: string,
  ) {
    super();
  }

  eq(other: PseudoSymbolWidget): boolean {
    return this.className === other.className && this.badgeText === other.badgeText;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.setAttribute("data-np-badge", this.badgeText);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildSymbolDecorations(view: EditorView, cfg: SymbolRenderConfig): DecorationSet {
  if (!cfg.space && !cfg.tab && !cfg.eol && !cfg.nonprint) {
    return Decoration.none;
  }
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const lineFrom = Math.max(from, line.from);
      const lineTo = Math.min(to, line.to);
      const text = doc.sliceString(lineFrom, lineTo);

      for (let i = 0; i < text.length; i += 1) {
        const ch = text.charCodeAt(i);
        const abs = lineFrom + i;
        if (ch === 32 && cfg.space) {
          builder.add(abs, abs + 1, Decoration.mark({ class: "np-sym-space" }));
        } else if (ch === 9 && cfg.tab) {
          builder.add(abs, abs + 1, Decoration.mark({ class: "np-sym-tab" }));
        } else if (cfg.nonprint && (ch < 32 || ch === 127) && ch !== 9) {
          const hex = ch.toString(16).toUpperCase().padStart(2, "0");
          builder.add(abs, abs + 1, Decoration.mark({ class: "np-sym-ctrl", attributes: { "data-np-badge": `x${hex}` } }));
        }
      }

      if (cfg.eol && line.to >= from && line.to <= to && line.number < doc.lines) {
        builder.add(
          line.to,
          line.to,
          Decoration.widget({ widget: new PseudoSymbolWidget("np-sym-eol", cfg.eolLabel), side: 1 }),
        );
      }

      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function createSymbolsExtension(initial: SymbolRenderConfig): Extension {
  const configField = StateField.define<SymbolRenderConfig>({
    create: () => initial,
    update(val, tr) {
      for (const e of tr.effects) {
        if (e.is(setSymbolConfigEffect)) return e.value;
      }
      return val;
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildSymbolDecorations(view, view.state.field(configField));
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(setSymbolConfigEffect)))
        ) {
          this.decorations = buildSymbolDecorations(update.view, update.state.field(configField));
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const attrs = EditorView.editorAttributes.of((view) => {
    const cfg = view.state.field(configField);
    const classes: string[] = [];
    if (cfg.indent) classes.push("np-show-indent");
    if (cfg.showRuler) classes.push("np-show-ruler");
    return {
      class: classes.join(" "),
      style: `--np-ruler-col: ${cfg.rulerCol}ch; --np-tab-ch: ${cfg.tabSize}ch;`,
    };
  });

  return [configField, plugin, attrs];
}
