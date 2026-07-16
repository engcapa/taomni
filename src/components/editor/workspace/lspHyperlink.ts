import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import type { LspPosition } from "../../../lib/editor/lsp";
import { lspPositionFromOffset } from "./lspPositions";

/** Identifier under the cursor for Ctrl/Cmd+hover hyperlinks (JS/TS/Java-ish). */
export function identifierRangeAt(docText: string, pos: number): { from: number; to: number } | null {
  if (pos < 0 || pos > docText.length) return null;
  const isId = (ch: string) => /[A-Za-z0-9_$@]/.test(ch);
  // Prefer the char before the caret when between tokens (common when pointing at the end of a word).
  let probe = pos;
  if (probe > 0 && !isId(docText[probe] ?? "") && isId(docText[probe - 1] ?? "")) {
    probe -= 1;
  }
  if (!isId(docText[probe] ?? "")) return null;
  let from = probe;
  let to = probe + 1;
  while (from > 0 && isId(docText[from - 1]!)) from -= 1;
  while (to < docText.length && isId(docText[to]!)) to += 1;
  if (to <= from) return null;
  // Leading digits alone are not useful go-to targets.
  if (/^\d+$/.test(docText.slice(from, to))) return null;
  return { from, to };
}

const setHyperlinkEffect = StateEffect.define<{ from: number; to: number } | null>();
const setModHeldEffect = StateEffect.define<boolean>();

const hyperlinkMark = Decoration.mark({ class: "cm-lsp-hyperlink" });

const hyperlinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHyperlinkEffect)) {
        if (!effect.value) return Decoration.none;
        const { from, to } = effect.value;
        if (to <= from || to > tr.state.doc.length) return Decoration.none;
        return Decoration.set([hyperlinkMark.range(from, to)]);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const modHeldField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setModHeldEffect)) return effect.value;
    }
    return value;
  },
});

export interface LspHyperlinkHooks {
  /** Ctrl/Cmd+click / middle-click go-to-definition. */
  onDefinition: (position: LspPosition) => Promise<boolean> | boolean;
  /**
   * Optional async probe: when the binary supports it, only keep the hyperlink
   * if a definition exists. Optimistic word underlines still appear immediately.
   */
  probeDefinition?: (position: LspPosition) => Promise<boolean>;
}

const HYPERLINK_THEME = EditorView.theme({
  ".cm-lsp-hyperlink": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    color: "var(--taomni-accent)",
    cursor: "pointer",
  },
  // Force pointer over the whole content while a hyperlink is active under the mouse.
  "&.cm-lsp-hyperlink-cursor .cm-content, &.cm-lsp-hyperlink-cursor .cm-line": {
    cursor: "pointer !important",
  },
});

function isGotoModifier(event: MouseEvent | KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

type HyperlinkPlugin = PluginValue & {
  handleMouseMove: (event: MouseEvent) => void;
  handleMouseLeave: () => void;
  goToAt: (event: MouseEvent, button: number) => boolean;
};

/**
 * IDEA-style Ctrl/Cmd+hover hyperlinks and click-to-definition chrome.
 * Middle-click also jumps to definition when over an identifier.
 */
export function createLspHyperlinkExtension(hooks: LspHyperlinkHooks): Extension {
  // Assigned after fromClass so eventHandlers can resolve the instance lazily.
  let plugin: ViewPlugin<HyperlinkPlugin>;
  plugin = ViewPlugin.fromClass(
    class implements HyperlinkPlugin {
      private modHeld = false;
      private lastPos: number | null = null;
      private probeToken = 0;
      private probeTimer: number | null = null;
      private readonly onKeyDown = (event: KeyboardEvent) => {
        if (!isGotoModifier(event)) return;
        if (this.modHeld) return;
        this.modHeld = true;
        this.view.dispatch({ effects: setModHeldEffect.of(true) });
        if (this.lastPos !== null) this.refreshAt(this.lastPos, true);
      };
      private readonly onKeyUp = (event: KeyboardEvent) => {
        if (event.key === "Control" || event.key === "Meta" || (!event.ctrlKey && !event.metaKey)) {
          if (!event.ctrlKey && !event.metaKey) this.clearMod();
        }
      };
      private readonly onBlur = () => this.clearMod();
      private readonly onWindowBlur = () => this.clearMod();

      constructor(readonly view: EditorView) {
        window.addEventListener("keydown", this.onKeyDown, true);
        window.addEventListener("keyup", this.onKeyUp, true);
        window.addEventListener("blur", this.onWindowBlur);
        view.contentDOM.addEventListener("blur", this.onBlur);
      }

      update(update: ViewUpdate) {
        if (update.docChanged && this.lastPos !== null) {
          this.refreshAt(this.lastPos, false);
        }
        const held = update.state.field(modHeldField);
        const hasLink = update.state.field(hyperlinkField).size > 0;
        update.view.dom.classList.toggle("cm-lsp-hyperlink-cursor", held && hasLink);
      }

      destroy() {
        window.removeEventListener("keydown", this.onKeyDown, true);
        window.removeEventListener("keyup", this.onKeyUp, true);
        window.removeEventListener("blur", this.onWindowBlur);
        this.view.contentDOM.removeEventListener("blur", this.onBlur);
        if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
      }

      private clearMod() {
        if (!this.modHeld && this.view.state.field(hyperlinkField).size === 0) return;
        this.modHeld = false;
        this.probeToken += 1;
        if (this.probeTimer !== null) {
          window.clearTimeout(this.probeTimer);
          this.probeTimer = null;
        }
        this.view.dispatch({
          effects: [setModHeldEffect.of(false), setHyperlinkEffect.of(null)],
        });
        this.view.dom.classList.remove("cm-lsp-hyperlink-cursor");
      }

      private clearLinkOnly() {
        if (this.view.state.field(hyperlinkField).size === 0) return;
        this.view.dispatch({ effects: setHyperlinkEffect.of(null) });
        this.view.dom.classList.remove("cm-lsp-hyperlink-cursor");
      }

      handleMouseMove(event: MouseEvent) {
        const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
        this.lastPos = pos;
        if (pos === null) {
          this.clearLinkOnly();
          return;
        }
        const mod = isGotoModifier(event);
        if (mod !== this.modHeld) {
          this.modHeld = mod;
          this.view.dispatch({ effects: setModHeldEffect.of(mod) });
        }
        if (!mod) {
          this.clearLinkOnly();
          return;
        }
        this.refreshAt(pos, true);
      }

      handleMouseLeave() {
        this.lastPos = null;
        this.clearLinkOnly();
      }

      private refreshAt(pos: number, scheduleProbe: boolean) {
        if (!this.modHeld) {
          this.clearLinkOnly();
          return;
        }
        const text = this.view.state.doc.toString();
        const range = identifierRangeAt(text, pos);
        if (!range) {
          this.clearLinkOnly();
          return;
        }
        const current = this.view.state.field(hyperlinkField);
        let same = false;
        current.between(range.from, range.to, (from: number, to: number) => {
          if (from === range.from && to === range.to) same = true;
        });
        if (!same) {
          this.view.dispatch({ effects: setHyperlinkEffect.of(range) });
          this.view.dom.classList.add("cm-lsp-hyperlink-cursor");
        }
        if (!scheduleProbe || !hooks.probeDefinition) return;
        if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
        const token = ++this.probeToken;
        const position = lspPositionFromOffset(this.view.state.doc, pos);
        this.probeTimer = window.setTimeout(() => {
          this.probeTimer = null;
          void Promise.resolve(hooks.probeDefinition?.(position)).then((ok) => {
            if (token !== this.probeToken || !this.modHeld) return;
            if (!ok) this.clearLinkOnly();
          });
        }, 90);
      }

      goToAt(event: MouseEvent, button: number): boolean {
        // 0 = primary, 1 = middle
        if (button !== 0 && button !== 1) return false;
        if (button === 0 && !isGotoModifier(event)) return false;
        const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const range = identifierRangeAt(this.view.state.doc.toString(), pos);
        if (!range) return false;
        event.preventDefault();
        event.stopPropagation();
        void hooks.onDefinition(lspPositionFromOffset(this.view.state.doc, pos));
        return true;
      }
    },
    {
      eventHandlers: {
        mousemove(event, view) {
          view.plugin(plugin)?.handleMouseMove(event);
          return false;
        },
        mouseleave(_event, view) {
          view.plugin(plugin)?.handleMouseLeave();
          return false;
        },
        mousedown(event, view) {
          return view.plugin(plugin)?.goToAt(event, event.button) ?? false;
        },
        auxclick(event, view) {
          if (event.button !== 1) return false;
          return view.plugin(plugin)?.goToAt(event, 1) ?? false;
        },
      },
    },
  );

  return [hyperlinkField, modHeldField, HYPERLINK_THEME, plugin];
}
