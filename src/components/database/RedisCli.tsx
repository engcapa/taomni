import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Trash2, Radio } from "lucide-react";
import { redisExec } from "../../lib/ipc";

interface RedisCliProps {
  sessionId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface CliLine {
  cmd?: string;
  reply: string;
  error?: boolean;
}

const KNOWN_COMMANDS = [
  "GET", "SET", "DEL", "EXPIRE", "TTL", "PERSIST", "KEYS", "SCAN", "TYPE",
  "HGET", "HSET", "HGETALL", "HDEL", "LPUSH", "RPUSH", "LRANGE", "LREM",
  "SADD", "SREM", "SMEMBERS", "ZADD", "ZRANGE", "ZREM", "XADD", "XRANGE",
  "INCR", "DECR", "EXISTS", "PING", "INFO", "DBSIZE", "FLUSHDB", "SELECT",
  "OBJECT", "MEMORY", "MONITOR",
];

export function RedisCli({ sessionId, collapsed, onToggleCollapse }: RedisCliProps) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<CliLine[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const historyRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const monitorTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      if (monitorTimer.current) clearInterval(monitorTimer.current);
    };
  }, []);

  const append = (line: CliLine) => setLines((prev) => [...prev, line].slice(-500));

  const runCommand = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    historyRef.current = [cmd, ...historyRef.current].slice(0, 200);
    historyIdx.current = -1;
    try {
      const reply = await redisExec(sessionId, cmd);
      append({ cmd, reply });
    } catch (err) {
      append({ cmd, reply: String(err), error: true });
    }
  };

  const tabComplete = () => {
    const upper = input.toUpperCase();
    const match = KNOWN_COMMANDS.find((c) => c.startsWith(upper) && c !== upper);
    if (match) setInput(match + " ");
  };

  const toggleMonitor = () => {
    // MONITOR streams server-side; we approximate by polling a lightweight
    // command set. A true streaming MONITOR needs a dedicated channel — here
    // we surface INFO commandstats deltas as a stand-in stream so the toggle
    // is functional without a long-lived subscription.
    if (monitoring) {
      if (monitorTimer.current) clearInterval(monitorTimer.current);
      monitorTimer.current = null;
      setMonitoring(false);
      append({ reply: "-- monitor stopped --" });
      return;
    }
    setMonitoring(true);
    append({ reply: "-- monitor started (polling INFO commandstats) --" });
    monitorTimer.current = setInterval(() => {
      redisExec(sessionId, "INFO commandstats")
        .then((reply) => {
          const firstLine = reply.split("\n").find((l) => l.includes("cmdstat")) ?? reply.split("\n")[0] ?? "";
          if (firstLine) append({ reply: firstLine });
        })
        .catch(() => undefined);
    }, 2000);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="h-7 shrink-0 w-full flex items-center gap-2 px-2 text-[11px]"
        style={{ background: "var(--taomni-quick-bg)", borderTop: "1px solid var(--taomni-divider)" }}
        onClick={onToggleCollapse}
      >
        <ChevronUp className="w-3.5 h-3.5" /> Redis CLI
      </button>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="redis-cli">
      <div
        className="h-7 shrink-0 flex items-center gap-2 px-2 text-[11px]"
        style={{ background: "var(--taomni-quick-bg)", borderTop: "1px solid var(--taomni-divider)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        <button type="button" className="inline-flex items-center gap-1" onClick={onToggleCollapse}>
          <ChevronDown className="w-3.5 h-3.5" /> Redis CLI
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)]"
          style={{ color: monitoring ? "#d9534f" : "var(--taomni-text-muted)" }}
          onClick={toggleMonitor}
          title="Toggle MONITOR"
        >
          <Radio className="w-3.5 h-3.5" /> {monitoring ? "Stop" : "Monitor"}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1.5 rounded hover:bg-[var(--taomni-hover)]"
          onClick={() => setLines([])}
          title="Clear output"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
      <div ref={outputRef} className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-2 font-mono text-[12px]" style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}>
        {lines.map((line, i) => (
          <div key={i}>
            {line.cmd && <div style={{ color: "var(--taomni-accent)" }}>&gt; {line.cmd}</div>}
            <pre className="whitespace-pre-wrap" style={{ color: line.error ? "#ff6b6b" : undefined, margin: 0 }}>
              {line.reply}
            </pre>
          </div>
        ))}
      </div>
      <div className="shrink-0 flex items-center gap-1 px-2 py-1" style={{ borderTop: "1px solid var(--taomni-divider)" }}>
        <span className="text-[var(--taomni-accent)] font-mono text-[12px]">&gt;</span>
        <input
          className="taomni-input flex-1 font-mono"
          value={input}
          placeholder="Type a Redis command and press Enter"
          aria-label="Redis command"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void runCommand(input);
              setInput("");
            } else if (e.key === "Tab") {
              e.preventDefault();
              tabComplete();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (historyIdx.current < historyRef.current.length - 1) {
                historyIdx.current += 1;
                setInput(historyRef.current[historyIdx.current] ?? "");
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (historyIdx.current > 0) {
                historyIdx.current -= 1;
                setInput(historyRef.current[historyIdx.current] ?? "");
              } else {
                historyIdx.current = -1;
                setInput("");
              }
            }
          }}
        />
      </div>
    </div>
  );
}
