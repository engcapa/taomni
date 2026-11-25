import { NotepadDialog } from "./NotepadDialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Change, diff, MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { normalizeWhitespace } from "../../../lib/diffWhitespace";
import type { NotepadCompareState } from "../../../stores/notepadStore";
import { useViewerLabels } from "../../viewer/viewerLabels";

export const MAX_COMPARE_BYTES = 5 * 1024 * 1024;

function foldCaseSameLength(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const folded = text[i].toLowerCase();
    out += folded.length === 1 ? folded : text[i];
  }
  return out;
}

export function buildCompareDiffOverride(
  ignoreWhitespace: boolean,
  ignoreCase: boolean,
): ((a: string, b: string) => readonly Change[]) | undefined {
  if (!ignoreWhitespace && !ignoreCase) return undefined;
  return (a: string, b: string) => {
    const na = normalizeWhitespace(a, ignoreWhitespace ? "all" : "none");
    const nb = normalizeWhitespace(b, ignoreWhitespace ? "all" : "none");
    const normA = ignoreCase ? foldCaseSameLength(na.norm) : na.norm;
    const normB = ignoreCase ? foldCaseSameLength(nb.norm) : nb.norm;
    const mapPos = (origLen: number, map: number[], pos: number) => {
      if (pos <= 0) return 0;
      if (pos >= map.length) return origLen;
      return map[pos];
    };
    return diff(normA, normB, { scanLimit: 500 }).map(
      (c) =>
        new Change(
          mapPos(a.length, na.map, c.fromA),
          mapPos(a.length, na.map, c.toA),
          mapPos(b.length, nb.map, c.fromB),
          mapPos(b.length, nb.map, c.toB),
        ),
    );
  };
}

export function CompareOverlay({
  compare,
  onPatch,
  onClose,
}: {
  compare: NotepadCompareState | null;
  onPatch: (patch: Partial<NotepadCompareState>) => void;
  onClose: () => void;
}) {
  const label = useViewerLabels();
  const hostRef = useRef<HTMLDivElement>(null);
  const [diffCount, setDiffCount] = useState(0);

  const open = Boolean(compare?.open);
  const leftContent = compare?.leftContent ?? "";
  const rightContent = compare?.rightContent ?? "";
  const ignoreWhitespace = Boolean(compare?.ignoreWhitespace);
  const ignoreCase = Boolean(compare?.ignoreCase);

  const exceedsLimit = useMemo(() => {
    if (!open) return false;
    const enc = new TextEncoder();
    return (
      enc.encode(leftContent).byteLength > MAX_COMPARE_BYTES ||
      enc.encode(rightContent).byteLength > MAX_COMPARE_BYTES
    );
  }, [open, leftContent, rightContent]);

  useEffect(() => {
    const container = hostRef.current;
    if (!open || !container || exceedsLimit) {
      setDiffCount(0);
      return;
    }
    const extensions = [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        "&": { height: "100%", color: "var(--taomni-text)", background: "var(--taomni-bg)", fontSize: "12px" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--taomni-font-mono, monospace)" },
      }),
    ];
    const override = buildCompareDiffOverride(ignoreWhitespace, ignoreCase);
    const mv = new MergeView({
      parent: container,
      a: { doc: leftContent, extensions },
      b: { doc: rightContent, extensions },
      orientation: "a-b",
      highlightChanges: true,
      gutter: true,
      diffConfig: override ? { override } : { scanLimit: 500 },
    });
    setDiffCount(mv.chunks.length);
    return () => {
      mv.destroy();
    };
  }, [open, leftContent, rightContent, ignoreWhitespace, ignoreCase, exceedsLimit]);

  if (!compare || !compare.open) return null;

  return (
    <NotepadDialog testId="notepad-compare-dialog" onClose={onClose} wide style={{ width: "min(980px, calc(100vw - 32px))" }} closeId="notepad-compare-close"
      title={<span>
            {label("文档对比", "Compare Documents")} ({diffCount} {label("处差异块", "diff chunk(s)")})
          </span>}>
      <div className="flex items-center gap-4 text-ui-body">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="notepad-compare-ignore-ws"
            checked={compare.ignoreWhitespace}
            onChange={(e) => onPatch({ ignoreWhitespace: e.target.checked })}
          />
          {label("忽略空白变化", "Ignore whitespace")}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="notepad-compare-ignore-case"
            checked={compare.ignoreCase}
            onChange={(e) => onPatch({ ignoreCase: e.target.checked })}
          />
          {label("忽略大小写", "Ignore case")}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2 text-ui-small font-semibold text-[var(--taomni-text-muted)]">
        <div className="truncate">{compare.leftTitle}</div>
        <div className="truncate">{compare.rightTitle}</div>
      </div>
      {exceedsLimit ? (
        <div
          className="flex items-center gap-2 p-4 rounded border border-ui-warning-border bg-ui-warning-surface text-ui-body"
          data-testid="notepad-compare-too-large"
        >
          <AlertTriangle size={16} className="text-ui-warning shrink-0" />
          <span>
            {label(
              "文档超过 5 MB 对比上限，无法在交互界面直接展开合并差异视图。",
              "One or both documents exceed the 5 MB interactive compare limit.",
            )}
          </span>
        </div>
      ) : (
        <div
          ref={hostRef}
          data-testid="notepad-compare-merge-view"
          className="h-96 overflow-auto border border-[var(--taomni-divider)] rounded"
        />
      )}
    </NotepadDialog>
  );
}
