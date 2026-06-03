import { useEffect, useState } from "react";
import { Save, Trash2, Pencil, Plus, RefreshCw, Braces } from "lucide-react";
import {
  redisGetKey,
  redisSetKey,
  redisDelKey,
  redisExec,
  type RedisValue,
} from "../../lib/ipc";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";

interface RedisValuePanelProps {
  sessionId: string;
  redisKey: string | null;
  onDeleted: () => void;
  onChanged: () => void;
}

function ttlText(ttl: number): string {
  if (ttl === -1) return "no expiry";
  if (ttl === -2) return "missing";
  return `${ttl}s`;
}

export function RedisValuePanel({ sessionId, redisKey, onDeleted, onChanged }: RedisValuePanelProps) {
  const [value, setValue] = useState<RedisValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!redisKey) {
      setValue(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setValue(await redisGetKey(sessionId, redisKey));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, redisKey]);

  if (!redisKey) {
    return (
      <div
        className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]"
        style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
      >
        Select a key to view its value.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0" style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}>
      {/* Metadata bar */}
      <div
        className="shrink-0 flex items-center gap-2 px-2 h-8 text-[11px]"
        style={{
          background: "var(--taomni-quick-bg)",
          borderBottom: "1px solid var(--taomni-divider)",
          fontSize: "var(--taomni-db-font-size-sm, 11px)",
        }}
      >
        <span className="px-1.5 rounded uppercase text-[10px]" style={{ background: "var(--taomni-accent)", color: "#fff" }}>
          {value?.kind ?? "?"}
        </span>
        <span className="font-mono truncate flex-1" title={redisKey}>{redisKey}</span>
        <span className="text-[var(--taomni-text-muted)]">TTL: {value ? ttlText(value.ttl) : "—"}</span>
        <button
          type="button"
          title="Edit TTL"
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          onClick={async () => {
            const input = await promptAppDialog({
              title: "Set TTL",
              label: "Set TTL in seconds (-1 = persist, 0 = remove key):",
              initialValue: String(value?.ttl ?? -1),
              allowEmpty: true,
            });
            if (input === null) return;
            const secs = parseInt(input, 10);
            if (Number.isNaN(secs)) return;
            try {
              if (secs === -1) await redisExec(sessionId, `PERSIST ${redisKey}`);
              else if (secs <= 0) {
                await redisDelKey(sessionId, redisKey);
                onDeleted();
                return;
              } else await redisExec(sessionId, `EXPIRE ${redisKey} ${secs}`);
              await load();
              onChanged();
            } catch (err) {
              setError(String(err));
            }
          }}
        >
          <Pencil className="w-3 h-3" />
        </button>
        {value?.encoding && <span className="text-[var(--taomni-text-muted)]">enc: {value.encoding}</span>}
        {value?.memoryUsage != null && <span className="text-[var(--taomni-text-muted)]">mem: {value.memoryUsage}B</span>}
        <button type="button" title="Reload" className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => void load()}>
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          title="Delete key"
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          style={{ color: "#d9534f" }}
          onClick={async () => {
            const confirmed = await confirmAppDialog({
              message: `Delete key "${redisKey}"?`,
              confirmLabel: "Delete",
              danger: true,
            });
            if (!confirmed) return;
            try {
              await redisDelKey(sessionId, redisKey);
              onDeleted();
            } catch (err) {
              setError(String(err));
            }
          }}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-2">
        {error && <div className="text-[11px] mb-2" style={{ color: "#d9534f" }}>{error}</div>}
        {value && (
          <ValueEditor
            sessionId={sessionId}
            redisKey={redisKey}
            value={value}
            onSaved={() => {
              void load();
              onChanged();
            }}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function ValueEditor({
  sessionId,
  redisKey,
  value,
  onSaved,
  onError,
}: {
  sessionId: string;
  redisKey: string;
  value: RedisValue;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  switch (value.kind) {
    case "string":
      return <StringEditor sessionId={sessionId} redisKey={redisKey} value={value.value as string} onSaved={onSaved} onError={onError} />;
    case "hash":
      return <PairEditor kind="hash" sessionId={sessionId} redisKey={redisKey} pairs={value.value as [string, string][]} headers={["Field", "Value"]} onSaved={onSaved} onError={onError} />;
    case "zset":
      return <PairEditor kind="zset" sessionId={sessionId} redisKey={redisKey} pairs={value.value as [string, string][]} headers={["Score", "Member"]} onSaved={onSaved} onError={onError} />;
    case "list":
      return <ListEditor kind="list" sessionId={sessionId} redisKey={redisKey} items={value.value as string[]} onSaved={onSaved} onError={onError} />;
    case "set":
      return <ListEditor kind="set" sessionId={sessionId} redisKey={redisKey} items={value.value as string[]} onSaved={onSaved} onError={onError} />;
    case "stream":
      return <StreamViewer entries={value.value as { id: string; fields: [string, string][] }[]} />;
    default:
      return (
        <div
          className="text-[12px] text-[var(--taomni-text-muted)]"
          style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
        >
          Empty or unknown value.
        </div>
      );
  }
}

function StringEditor({
  sessionId,
  redisKey,
  value,
  onSaved,
  onError,
}: {
  sessionId: string;
  redisKey: string;
  value: string;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState(value);
  const [pretty, setPretty] = useState(false);
  useEffect(() => setText(value), [value]);

  const isJson = (() => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  })();

  const display = pretty && isJson ? JSON.stringify(JSON.parse(text), null, 2) : text;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="taomni-btn px-2 py-0.5 text-[11px] flex items-center gap-1"
          onClick={async () => {
            try {
              await redisSetKey(sessionId, redisKey, "string", text);
              onSaved();
            } catch (err) {
              onError(String(err));
            }
          }}
        >
          <Save className="w-3 h-3" /> Save
        </button>
        {isJson && (
          <label className="text-[11px] flex items-center gap-1 cursor-pointer">
            <input type="checkbox" className="taomni-checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} />
            <Braces className="w-3 h-3" /> Format JSON
          </label>
        )}
      </div>
      <textarea
        className="taomni-input flex-1 font-mono"
        style={{
          minHeight: 200,
          padding: 8,
          resize: "none",
          fontSize: "var(--taomni-db-font-size, 12px)",
        }}
        value={display}
        readOnly={pretty}
        onChange={(e) => setText(e.target.value)}
        aria-label="String value"
      />
    </div>
  );
}

function PairEditor({
  kind,
  sessionId,
  redisKey,
  pairs,
  headers,
  onSaved,
  onError,
}: {
  kind: "hash" | "zset";
  sessionId: string;
  redisKey: string;
  pairs: [string, string][];
  headers: [string, string];
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(pairs);
  useEffect(() => setRows(pairs), [pairs]);

  const save = async () => {
    try {
      await redisSetKey(sessionId, redisKey, kind, rows.filter(([a]) => a !== ""));
      onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="taomni-btn px-2 py-0.5 text-[11px] flex items-center gap-1 self-start" onClick={save}>
        <Save className="w-3 h-3" /> Save
      </button>
      <table className="w-full text-[12px]" style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}>
        <thead>
          <tr className="text-left text-[var(--taomni-text-muted)]">
            <th className="px-1 py-0.5 w-1/3">{headers[0]}</th>
            <th className="px-1 py-0.5">{headers[1]}</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="px-1 py-0.5">
                <input
                  className="taomni-input w-full font-mono"
                  style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
                  value={row[0]}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
                />
              </td>
              <td className="px-1 py-0.5">
                <input
                  className="taomni-input w-full font-mono"
                  style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
                  value={row[1]}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}
                />
              </td>
              <td>
                <button type="button" className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                  <Trash2 className="w-3 h-3" style={{ color: "#d9534f" }} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="taomni-btn px-2 py-0.5 text-[11px] flex items-center gap-1 self-start" onClick={() => setRows((r) => [...r, ["", ""]])}>
        <Plus className="w-3 h-3" /> Add {kind === "hash" ? "field" : "member"}
      </button>
    </div>
  );
}

function ListEditor({
  kind,
  sessionId,
  redisKey,
  items,
  onSaved,
  onError,
}: {
  kind: "list" | "set";
  sessionId: string;
  redisKey: string;
  items: string[];
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<string[]>(items);
  useEffect(() => setRows(items), [items]);

  const save = async () => {
    try {
      await redisSetKey(sessionId, redisKey, kind, rows.filter((x) => x !== ""));
      onSaved();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="taomni-btn px-2 py-0.5 text-[11px] flex items-center gap-1 self-start" onClick={save}>
        <Save className="w-3 h-3" /> Save
      </button>
      <div className="flex flex-col gap-1">
        {rows.map((item, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--taomni-text-muted)] w-8 text-right">{kind === "list" ? i : "•"}</span>
            <input
              className="taomni-input flex-1 font-mono"
              style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
              value={item}
              onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button type="button" className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              <Trash2 className="w-3 h-3" style={{ color: "#d9534f" }} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="taomni-btn px-2 py-0.5 text-[11px] flex items-center gap-1 self-start" onClick={() => setRows((r) => [...r, ""])}>
        <Plus className="w-3 h-3" /> Add {kind === "list" ? "item" : "member"}
      </button>
    </div>
  );
}

function StreamViewer({ entries }: { entries: { id: string; fields: [string, string][] }[] }) {
  return (
    <div className="text-[12px] font-mono" style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[var(--taomni-text-muted)]">
            <th className="px-1 py-0.5">Entry ID</th>
            <th className="px-1 py-0.5">Field</th>
            <th className="px-1 py-0.5">Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.flatMap((entry) =>
            entry.fields.map(([f, v], i) => (
              <tr key={`${entry.id}-${i}`} style={{ borderTop: i === 0 ? "1px solid var(--taomni-divider)" : undefined }}>
                <td className="px-1 py-0.5 align-top">{i === 0 ? entry.id : ""}</td>
                <td className="px-1 py-0.5">{f}</td>
                <td className="px-1 py-0.5 truncate" title={v}>{v}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
