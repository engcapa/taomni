import { useState } from "react";
import { Network, Play, CheckCircle2, XCircle } from "lucide-react";
import { testProxyConnection } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import type { ProxyTestTabInfo } from "../../types";

export default function ProxyTestTab({ info }: { info: ProxyTestTabInfo }) {
  const t = useT();
  const [testUrl, setTestUrl] = useState(info.testUrl || "google.com:80");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const [testHost, testPortStr] = testUrl.split(":");
      const testPort = parseInt(testPortStr) || 80;
      const msg = await testProxyConnection(
        info.proxyKind,
        info.host,
        info.port,
        info.username || "",
        info.password || "",
        testHost,
        testPort,
      );
      setResult({ ok: true, msg });
    } catch (err) {
      setResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
      <div className="flex items-center gap-3">
        <Network className="w-8 h-8 text-[var(--taomni-text-muted)]" />
        <div>
          <div className="text-sm font-medium">
            {info.proxyKind === "http" ? "HTTP CONNECT" : "SOCKS 5"} Proxy
          </div>
          <div className="text-xs text-[var(--taomni-text-muted)]">
            {info.host}:{info.port}
            {info.username ? ` (${info.username})` : ""}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--taomni-text-muted)]">
          {t("sessionEditor2.proxyTestUrl")}:
        </label>
        <input
          className="taomni-input w-48 text-xs"
          value={testUrl}
          placeholder={t("sessionEditor2.proxyTestUrlPlaceholder")}
          onChange={(e) => setTestUrl(e.target.value)}
        />
        <button
          className="taomni-btn flex items-center gap-1.5 px-3 py-1.5"
          onClick={() => void handleTest()}
          disabled={testing}
          type="button"
        >
          <Play className="w-3.5 h-3.5" />
          {testing ? t("sessionEditor2.proxyTestTesting") : t("sessionEditor2.proxyTestBtn")}
        </button>
      </div>

      {result && (
        <div className={`flex items-center gap-2 text-sm ${result.ok ? "text-green-600" : "text-red-600"}`}>
          {result.ok
            ? <CheckCircle2 className="w-5 h-5" />
            : <XCircle className="w-5 h-5" />}
          <span>{result.msg}</span>
        </div>
      )}
    </div>
  );
}
