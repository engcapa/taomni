import { useEffect, useRef } from "react";
import { Copy, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import type { DbQueryResult } from "../../lib/ipc";

/** Content shown in the read-only object detail dialog. */
export type ObjectDetail =
  | { kind: "ddl"; title: string; sql: string }
  | { kind: "result"; title: string; result: DbQueryResult };

interface Props {
  detail: ObjectDetail;
  onClose: () => void;
  onStatus?: (message: string) => void;
}

export function DbObjectDetailDialog({ detail, onClose, onStatus }: Props) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const copyText =
    detail.kind === "ddl"
      ? detail.sql
      : detail.result.rows.map((r) => r.map((c) => c ?? "").join("\t")).join("\n");

  const copyAll = async () => {
    await writeText(copyText);
    onStatus?.(t("dbObjects.copied"));
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-label={detail.title}
        aria-modal="true"
        data-testid="db-object-detail-dialog"
        className="w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col rounded shadow-lg"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="h-9 shrink-0 flex items-center gap-2 px-3"
          style={{ borderBottom: "1px solid var(--taomni-divider)" }}
        >
          <span className="text-[12px] font-semibold truncate flex-1">{detail.title}</span>
          <button
            type="button"
            className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            onClick={() => void copyAll()}
            title={t("dbObjects.copy")}
          >
            <Copy className="w-3.5 h-3.5" /> {t("dbObjects.copy")}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3">
          {detail.kind === "ddl" ? (
            <pre
              className="text-[12px] font-mono whitespace-pre-wrap break-words m-0"
              style={{ color: "var(--taomni-text)" }}
            >
              {detail.sql}
            </pre>
          ) : (
            <StatsTable result={detail.result} empty={t("dbObjects.noData")} />
          )}
        </div>
      </div>
    </div>
  );
}

function StatsTable({ result, empty }: { result: DbQueryResult; empty: string }) {
  if (result.rows.length === 0) {
    return <div className="text-[12px] text-[var(--taomni-text-muted)]">{empty}</div>;
  }
  return (
    <table className="w-full text-[12px] border-collapse">
      <thead>
        <tr>
          {result.columns.map((c) => (
            <th
              key={c.name}
              className="text-left px-2 py-1 font-semibold"
              style={{ borderBottom: "1px solid var(--taomni-divider)" }}
            >
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td
                key={j}
                className="px-2 py-1 align-top font-mono"
                style={{ borderBottom: "1px solid var(--taomni-divider)" }}
              >
                {cell ?? <span className="text-[var(--taomni-text-muted)]">NULL</span>}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
