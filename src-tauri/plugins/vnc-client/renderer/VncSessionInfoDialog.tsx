import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { Modal } from "../../../crates/taomni-plugin-api/frontend/ui/Modal";
import type { VncSessionStats } from "../../../../src/lib/vnc/viewerProtocol";
import type { VncPaintStats } from "./vncFramePainter";
import { useT } from "../../../../src/lib/vnc/viewerHost";

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
  /** WebView main-thread paint cost (VNC-PERF-003). */
  paint?: VncPaintStats | null;
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
export function VncSessionInfoDialog({ info, onClose, returnFocus }: {
  info: VncSessionInfo;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const t = useT();
  const stats = info.stats;
  const qualityLabel = (value: string) => {
    switch (value) {
      case "automatic":
        return t("vnc.qualityAutomatic");
      case "high":
        return t("vnc.qualityHigh");
      case "medium":
        return t("vnc.qualityMedium");
      case "low":
        return t("vnc.qualityLow");
      default:
        return value;
    }
  };
  const rows: Array<[string, string]> = [
    [t("vnc.infoDesktopName"), info.desktopName || "-"],
    [t("vnc.infoDevice"), info.device],
    [t("vnc.infoSize"), info.width && info.height ? `${info.width} x ${info.height}` : "-"],
    [t("vnc.infoPixelFormat"), stats?.pixel_format ?? t("vnc.infoCollecting")],
    [
      t("vnc.infoQuality"),
      stats?.quality
        ? t("vnc.infoQualityValue", {
          preset: qualityLabel(stats.quality),
          level: qualityLabel(stats.quality_level ?? stats.quality),
        })
        : t("vnc.infoCollecting"),
    ],
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
    [
      t("vnc.infoPaint"),
      info.paint
        ? t("vnc.infoPaintValue", {
          avg: info.paint.avgPaintMs.toFixed(1),
          full: info.paint.fullFrame
            ? (info.paint.fullFrame.receiveMs + info.paint.fullFrame.paintMs).toFixed(1)
            : "-",
        })
        : t("vnc.infoCollecting"),
    ],
    [t("vnc.infoProtocol"), info.protocol || "-"],
    [
      t("vnc.infoSecurity"),
      `${info.encrypted ? t("vnc.infoEncrypted") : t("vnc.infoUnencrypted")} [${info.security || "-"}]`,
    ],
    [t("vnc.infoConnectionType"), info.proxied ? t("vnc.infoProxied") : t("vnc.infoDirect")],
  ];

  return (
    <Modal title={t("vnc.infoTitle")} testId="vnc-session-info" closeLabel={t("vnc.close")}
      initialFocus='[data-testid="vnc-session-info-ok"]' returnFocus={returnFocus}
      dismissOnBackdrop onCancel={onClose} footer={
        <Button data-testid="vnc-session-info-ok" variant="primary" onClick={onClose}>{t("vnc.ok")}</Button>
      }>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(min-content, max-content) minmax(0, 1fr)", columnGap: 24, rowGap: 6 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt className="text-[var(--taomni-text-muted)]">{label}:</dt>
            <dd data-testid={`vnc-info-${label}`} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
