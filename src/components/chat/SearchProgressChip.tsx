import { useEffect, useState } from "react";
import { Globe, Loader2, X } from "lucide-react";
import { useT } from "../../lib/i18n";

interface SearchProgressChipProps {
  query: string;
  provider: string;
  onCancel?: () => void;
  done?: boolean;
  resultCount?: number;
}

export function SearchProgressChip({ query, provider, onCancel, done, resultCount }: SearchProgressChipProps) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (done) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 100) / 10), 100);
    return () => clearInterval(id);
  }, [done]);

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] px-2.5 py-1 text-[11px]">
      {done ? (
        <Globe className="w-3 h-3 text-green-400 shrink-0" />
      ) : (
        <Loader2 className="w-3 h-3 animate-spin text-[var(--moba-accent)] shrink-0" />
      )}
      <span className="text-[var(--moba-text-muted)]">
        {done
          ? t("chat.searchChipDoneCount", { count: resultCount ?? 0, provider })
          : t("chat.searchChipPending", {
              query: `${query.slice(0, 30)}${query.length > 30 ? "…" : ""}`,
              provider,
              elapsed,
            })
        }
      </span>
      {!done && onCancel && (
        <button
          type="button"
          className="text-[var(--moba-text-muted)] hover:text-[var(--moba-text)] ml-0.5"
          onClick={onCancel}
          title={t("chat.searchChipCancel")}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
