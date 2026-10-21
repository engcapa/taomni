import { lazy } from "react";
import { useT } from "../../lib/i18n";


export const VncPanel = lazy(() => import("../../components/vnc/VncPanel"));

export const RdpPanel = lazy(() => import("../../components/rdp/RdpPanel"));

export const DbClientTab = lazy(() => import("../../components/database/DbClientTab"));

export const RedisClientTab = lazy(() => import("../../components/database/RedisClientTab"));

export const HBaseShellTab = lazy(() => import("../../components/database/HBaseShellTab"));

export const ProxyTestTab = lazy(() => import("../../components/proxy/ProxyTestTab"));


export function VncLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("vnc.loading")}
    </div>
  );
}


export function RdpLoadingPanel() {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      {t("rdp.loading")}
    </div>
  );
}


export function DbLoadingPanel() {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
    >
      Loading database client…
    </div>
  );
}


export function UnavailablePanel({ title, message }: { title: string; message?: string }) {
  const t = useT();
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm p-6"
      style={{ background: "var(--taomni-term-bg)", color: "var(--taomni-term-text)" }}
    >
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold mb-2">{title}</div>
        <div className="text-[12px] text-slate-300">
          {message ?? t("status.commandUnavailable")}
        </div>
      </div>
    </div>
  );
}
