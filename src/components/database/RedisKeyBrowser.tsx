import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  Timer,
  ChevronRight,
  ChevronDown,
  Folder,
  Search,
} from "lucide-react";
import {
  redisListKeys,
  type RedisKeyEntry,
} from "../../lib/ipc";

interface RedisKeyBrowserProps {
  sessionId: string;
  separator?: string;
  /** Bump to force a reload from the parent (e.g. after DB index switch). */
  reloadToken: number;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
  onAddKey: () => void;
  onDeleteKey: (key: string) => void;
  onSetTtl: (key: string) => void;
}

const PAGE_COUNT = 300;
const TTL_REFRESH_MS = 10_000;

function ttlColor(ttl: number): string {
  if (ttl === -1) return "#62d36f"; // persistent
  if (ttl < 0) return "var(--taomni-text-muted)";
  if (ttl < 60) return "#d9534f";
  return "#e6a817";
}

function ttlLabel(ttl: number): string {
  if (ttl === -1) return "∞";
  if (ttl === -2) return "—";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

const TYPE_COLORS: Record<string, string> = {
  string: "#3b7ac2",
  hash: "#a04b9c",
  list: "#e6a817",
  set: "#62d36f",
  zset: "#cc6f00",
  stream: "#7a3d9d",
  none: "var(--taomni-text-muted)",
};

interface FolderNode {
  name: string;
  fullPrefix: string;
  children: Map<string, FolderNode>;
  keys: RedisKeyEntry[];
}

function buildTree(keys: RedisKeyEntry[], sep: string): FolderNode {
  const root: FolderNode = { name: "", fullPrefix: "", children: new Map(), keys: [] };
  for (const entry of keys) {
    const parts = sep ? entry.key.split(sep) : [entry.key];
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const prefix = parts.slice(0, i + 1).join(sep);
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, fullPrefix: prefix, children: new Map(), keys: [] });
      }
      node = node.children.get(seg)!;
    }
    node.keys.push(entry);
  }
  return root;
}

export function RedisKeyBrowser({
  sessionId,
  separator = ":",
  reloadToken,
  selectedKey,
  onSelectKey,
  onAddKey,
  onDeleteKey,
  onSetTtl,
}: RedisKeyBrowserProps) {
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [cursor, setCursor] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const patternRef = useRef(pattern);
  patternRef.current = pattern;

  const scan = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const startCursor = reset ? "0" : cursor;
        const page = await redisListKeys(sessionId, patternRef.current || "*", startCursor, PAGE_COUNT);
        setCursor(page.cursor);
        setKeys((prev) => {
          const base = reset ? [] : prev;
          const seen = new Set(base.map((k) => k.key));
          const merged = [...base];
          for (const k of page.keys) {
            if (!seen.has(k.key)) merged.push(k);
          }
          return merged;
        });
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, cursor],
  );

  // Initial + reload-token-driven scan.
  useEffect(() => {
    void scan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reloadToken]);

  // Periodic TTL refresh: re-scan from cursor 0 quietly to refresh TTL pills.
  useEffect(() => {
    const id = setInterval(() => {
      redisListKeys(sessionId, patternRef.current || "*", "0", PAGE_COUNT)
        .then((page) => {
          const ttlByKey = new Map(page.keys.map((k) => [k.key, k.ttl]));
          setKeys((prev) => prev.map((k) => (ttlByKey.has(k.key) ? { ...k, ttl: ttlByKey.get(k.key)! } : k)));
        })
        .catch(() => undefined);
    }, TTL_REFRESH_MS);
    return () => clearInterval(id);
  }, [sessionId]);

  const tree = buildTree(keys, separator);

  const renderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {folders.map((child) => {
          const isOpen = expanded[child.fullPrefix] ?? false;
          const totalKeys = countKeys(child);
          return (
            <div key={child.fullPrefix}>
              <button
                type="button"
                className="taomni-tree-row w-full text-left"
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => setExpanded((p) => ({ ...p, [child.fullPrefix]: !isOpen }))}
              >
                {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Folder className="w-3.5 h-3.5" style={{ color: "#e6a817" }} />
                <span className="flex-1 truncate">{child.name}</span>
                <span className="text-[10px] text-[var(--taomni-text-muted)]">{totalKeys}</span>
              </button>
              {isOpen && renderNode(child, depth + 1)}
            </div>
          );
        })}
        {node.keys
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((entry) => {
            const leaf = separator ? entry.key.split(separator).pop() ?? entry.key : entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                className="taomni-tree-row w-full text-left"
                style={{
                  paddingLeft: 6 + depth * 12 + 12,
                  background: selectedKey === entry.key ? "var(--taomni-selected)" : undefined,
                }}
                onClick={() => onSelectKey(entry.key)}
                title={entry.key}
              >
                <span
                  className="text-[9px] px-1 rounded shrink-0 uppercase"
                  style={{ background: TYPE_COLORS[entry.type] ?? "var(--taomni-divider)", color: "#fff" }}
                >
                  {entry.type.slice(0, 3)}
                </span>
                <span className="flex-1 truncate">{leaf}</span>
                <span className="text-[10px] shrink-0" style={{ color: ttlColor(entry.ttl) }}>
                  {ttlLabel(entry.ttl)}
                </span>
              </button>
            );
          })}
      </>
    );
  };

  return (
    <div className="h-full flex flex-col" data-testid="redis-key-browser">
      <div className="shrink-0 px-1.5 py-1" style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              className="taomni-input w-full"
              style={{ paddingLeft: 22 }}
              value={pattern}
              placeholder="* (glob pattern)"
              aria-label="Key pattern"
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void scan(true);
              }}
            />
          </div>
          <button
            type="button"
            title="Scan"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
            onClick={() => void scan(true)}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex items-center gap-1 mt-1">
          <button type="button" className="taomni-btn px-1.5 py-0.5 text-[11px] flex items-center gap-1" onClick={onAddKey}>
            <Plus className="w-3 h-3" /> Add
          </button>
          <button
            type="button"
            className="taomni-btn px-1.5 py-0.5 text-[11px] flex items-center gap-1"
            disabled={!selectedKey}
            onClick={() => selectedKey && onDeleteKey(selectedKey)}
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
          <button
            type="button"
            className="taomni-btn px-1.5 py-0.5 text-[11px] flex items-center gap-1"
            disabled={!selectedKey}
            onClick={() => selectedKey && onSetTtl(selectedKey)}
          >
            <Timer className="w-3 h-3" /> TTL
          </button>
          <span className="ml-auto text-[10px] text-[var(--taomni-text-muted)]">{keys.length} keys</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y py-1 text-[12px]">
        {error && <div className="px-2 py-1 text-[11px]" style={{ color: "#d9534f" }}>{error}</div>}
        {renderNode(tree, 0)}
        {cursor !== "0" && (
          <button
            type="button"
            className="w-full text-center py-1 text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
            onClick={() => void scan(false)}
          >
            Load more…
          </button>
        )}
      </div>
    </div>
  );
}

function countKeys(node: FolderNode): number {
  let n = node.keys.length;
  for (const child of node.children.values()) n += countKeys(child);
  return n;
}
