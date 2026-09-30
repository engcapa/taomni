import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { VncSessionStats } from "../../lib/vnc";
import { useT } from "../../lib/i18n";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";

export interface VncSessionInfo {
  desktopName: string;
  device: string;
  width: number;
  height: number;
  protocol: string;
  security: string;
  encrypted: boolean;
  proxied: boolean;
  stats: VncSessionStats | null;
}

function formatKbps(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value).toLocaleString()} kbit/s`;
}

/**
 * Session Information, modelled on RealVNC Viewer's F8 > Session
 * Information dialog, plus Taomni's pipeline counters (updates vs painted
 * frames, per-update decode time) for performance diagnosis.
 */
export function VncSessionInfoDialog({ info, onClose }: { info: VncSessionInfo; onClose: () => void }) {
  const t = useT();
  useFocusReturn(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  const stats = info.stats;
  const rows: Array<[string, string]> = [
    [t("vnc.infoDesktopName"), info.desktopName || "-"],
    [t("vnc.infoDevice"), info.device],
    [t("vnc.infoSize"), info.width && info.height ? `${info.width} x ${info.height}` : "-"],
    [t("vnc.infoPixelFormat"), stats?.pixel_format ?? t("vnc.infoCollecting")],
    [t("vnc.infoRequestedEncoding"), stats?.requested_encoding ?? t("vnc.infoCollecting")],
    [t("vnc.infoLastEncoding"), stats?.last_encoding ?? t("vnc.infoCollecting")],
    [
      t("vnc.infoLineSpeed"),
      stats ? `${formatKbps(stats.line_kbps)} (${formatKbps(stats.wire_kbps)} now)` : t("vnc.infoCollecting"),
    ],
    [
      t("vnc.infoUpdates"),
      stats
        ? t("vnc.infoUpdatesValue", {
          updates: stats.updates_per_sec.toFixed(1),
          frames: stats.frames_per_sec.toFixed(1),
        })
        : t("vnc.infoCollecting"),
    ],
    [t("vnc.infoDecode"), stats ? `${stats.update_ms.toFixed(1)} ms` : t("vnc.infoCollecting")],
    [t("vnc.infoProtocol"), info.protocol || "-"],
    [
      t("vnc.infoSecurity"),
      `${info.encrypted ? t("vnc.infoEncrypted") : t("vnc.infoUnencrypted")} [${info.security || "-"}]`,
    ],
    [t("vnc.infoConnectionType"), info.proxied ? t("vnc.infoProxied") : t("vnc.infoDirect")],
  ];

  return (
    <div
      role="presentation"
      style={{ position: "absolute", inset: 0, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vnc-session-info-title"
        data-testid="vnc-session-info"
        className="rounded-md border border-[var(--taomni-border)] bg-[var(--taomni-bg-elevated,var(--taomni-bg))] text-[var(--taomni-text)] shadow-xl"
        style={{ minWidth: 420, maxWidth: "90%", padding: 16 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 id="vnc-session-info-title" style={{ fontSize: 14, fontWeight: 600 }}>{t("vnc.infoTitle")}</h2>
          <button
            type="button"
            aria-label={t("vnc.close")}
            onClick={onClose}
            className="rounded p-1 hover:bg-[var(--taomni-bg-hover)]"
          >
            <X size={14} />
          </button>
        </div>
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 24, rowGap: 6, fontSize: 12 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt className="text-[var(--taomni-text-muted)]">{label}:</dt>
              <dd data-testid={`vnc-info-${label}`} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</dd>
            </div>
          ))}
        </dl>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button
            ref={closeRef}
            type="button"
            data-testid="vnc-session-info-ok"
            onClick={onClose}
            className="rounded border border-[var(--taomni-border)] px-4 py-1 text-xs hover:bg-[var(--taomni-bg-hover)]"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
