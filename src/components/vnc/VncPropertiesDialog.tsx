import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { normalizeVncScaling, VNC_SCALE_PERCENTAGES, type VncClipboardPolicy, type VncScaling } from "../../lib/vnc";
import type { VncMenuKey, VncPictureQuality, VncViewerOptions } from "../../lib/vncOptions";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";

/** Settings the Properties dialog edits (VNC-CONN-001). */
export interface VncSessionProperties {
  viewer: VncViewerOptions;
  viewOnly: boolean;
  clipboardPolicy: VncClipboardPolicy;
}

/** Changing any of these only takes effect on the next connection. */
export function propertiesNeedReconnect(before: VncSessionProperties, after: VncSessionProperties): boolean {
  return before.viewOnly !== after.viewOnly
    || before.clipboardPolicy !== after.clipboardPolicy
    || before.viewer.shared !== after.viewer.shared;
}

const QUALITIES: VncPictureQuality[] = ["automatic", "high", "medium", "low"];
const MENU_KEYS: VncMenuKey[] = ["F8", "F9", "F10", "F11", "F12", "none"];

/**
 * In-session Properties, modelled on RealVNC Viewer's Properties > Options:
 * picture quality, scaling, keys, clipboard and connection. Immediate
 * options apply on OK; the ones the server negotiates at connect time offer
 * "OK and reconnect".
 */
export function VncPropertiesDialog({
  initial,
  onApply,
  onClose,
}: {
  initial: VncSessionProperties;
  onApply: (next: VncSessionProperties, reconnect: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  useFocusReturn(true);
  const [draft, setDraft] = useState<VncSessionProperties>(initial);
  const firstRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, []);
  const needsReconnect = propertiesNeedReconnect(initial, draft);
  const setViewer = <K extends keyof VncViewerOptions>(key: K, value: VncViewerOptions[K]) =>
    setDraft((current) => ({ ...current, viewer: { ...current.viewer, [key]: value } }));
  const scalingValue = String(draft.viewer.scaling);

  const row = (label: string, control: React.ReactNode) => (
    <label style={{ display: "contents" }}>
      <span className="text-[var(--taomni-text-muted)]">{label}</span>
      {control}
    </label>
  );
  const check = (testId: string, checked: boolean, onChange: (value: boolean) => void, label: string) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center", gridColumn: "1 / -1" }}>
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
  const section = (title: string) => (
    <h3 style={{ gridColumn: "1 / -1", fontWeight: 600, marginTop: 8 }}>{title}</h3>
  );

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
        aria-labelledby="vnc-properties-title"
        data-testid="vnc-properties"
        className="rounded-md border border-[var(--taomni-border)] bg-[var(--taomni-bg-elevated,var(--taomni-bg))] text-[var(--taomni-text)] shadow-xl"
        style={{ minWidth: 440, maxWidth: "90%", maxHeight: "90%", overflow: "auto", padding: 16, fontSize: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h2 id="vnc-properties-title" style={{ fontSize: 14, fontWeight: 600 }}>{t("vnc.propertiesTitle")}</h2>
          <button type="button" aria-label={t("vnc.close")} onClick={onClose} className="rounded p-1 hover:bg-[var(--taomni-bg-hover)]">
            <X size={14} />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 8, alignItems: "center" }}>
          {section(t("vnc.propertiesGeneral"))}
          {row(t("vnc.pictureQuality"), (
            <select
              ref={firstRef}
              data-testid="vnc-prop-quality"
              className="taomni-input"
              value={draft.viewer.pictureQuality}
              onChange={(event) => setViewer("pictureQuality", event.target.value as VncPictureQuality)}
            >
              {QUALITIES.map((quality) => (
                <option key={quality} value={quality}>{t(`vnc.quality${quality[0].toUpperCase()}${quality.slice(1)}`)}</option>
              ))}
            </select>
          ))}
          {check("vnc-prop-view-only", draft.viewOnly, (value) => setDraft((current) => ({ ...current, viewOnly: value })), t("vnc.propertiesViewOnly"))}
          {section(t("vnc.scaling"))}
          {row(t("vnc.scaling"), (
            <select
              data-testid="vnc-prop-scaling"
              className="taomni-input"
              value={scalingValue}
              onChange={(event) => setViewer("scaling", normalizeVncScaling(event.target.value) as VncScaling)}
            >
              <option value="auto">{t("vnc.scaleAutomatically")}</option>
              <option value="fit">{t("vnc.scaleFitWindow")}</option>
              <option value="fit-width">{t("vnc.scaleFitWidth")}</option>
              <option value="fit-height">{t("vnc.scaleFitHeight")}</option>
              {VNC_SCALE_PERCENTAGES.map((percent) => (
                <option key={percent} value={String(percent)}>{percent}%</option>
              ))}
            </select>
          ))}
          {check("vnc-prop-preserve-aspect", draft.viewer.preserveAspect, (value) => setViewer("preserveAspect", value), t("vnc.preserveAspect"))}
          {section(t("vnc.propertiesKeys"))}
          {check("vnc-prop-special-keys", draft.viewer.passSpecialKeys, (value) => setViewer("passSpecialKeys", value), t("vnc.propertiesPassSpecialKeys"))}
          {row(t("vnc.propertiesMenuKey"), (
            <select
              data-testid="vnc-prop-menu-key"
              className="taomni-input"
              value={draft.viewer.menuKey}
              onChange={(event) => setViewer("menuKey", event.target.value as VncMenuKey)}
            >
              {MENU_KEYS.map((key) => (
                <option key={key} value={key}>{key === "none" ? t("vnc.propertiesMenuKeyNone") : key}</option>
              ))}
            </select>
          ))}
          {section(t("vnc.propertiesClipboard"))}
          {row(t("vnc.propertiesClipboardDirection"), (
            <select
              data-testid="vnc-prop-clipboard"
              className="taomni-input"
              value={draft.clipboardPolicy}
              onChange={(event) => setDraft((current) => ({ ...current, clipboardPolicy: event.target.value as VncClipboardPolicy }))}
            >
              <option value="bidirectional">{t("vnc.clipboardBidirectional")}</option>
              <option value="client-to-server">{t("vnc.clipboardClientToServer")}</option>
              <option value="server-to-client">{t("vnc.clipboardServerToClient")}</option>
              <option value="disabled">{t("vnc.clipboardDisabled")}</option>
            </select>
          ))}
          {check("vnc-prop-initial-clipboard", draft.viewer.sendInitialClipboard, (value) => setViewer("sendInitialClipboard", value), t("vnc.propertiesSendInitialClipboard"))}
          {section(t("vnc.propertiesConnection"))}
          {check("vnc-prop-shared", draft.viewer.shared, (value) => setViewer("shared", value), t("vnc.propertiesShared"))}
          {check("vnc-prop-warn-unencrypted", draft.viewer.warnUnencrypted, (value) => setViewer("warnUnencrypted", value), t("vnc.propertiesWarnUnencrypted"))}
          {check("vnc-prop-auto-reconnect", draft.viewer.autoReconnect, (value) => setViewer("autoReconnect", value), t("vnc.propertiesAutoReconnect"))}
          {check("vnc-prop-bell", draft.viewer.acceptBell, (value) => setViewer("acceptBell", value), t("vnc.propertiesAcceptBell"))}
        </div>
        {needsReconnect && (
          <p data-testid="vnc-prop-reconnect-hint" style={{ marginTop: 12, color: "var(--taomni-text-muted)" }}>
            {t("vnc.propertiesReconnectHint")}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          {needsReconnect && (
            <button
              type="button"
              data-testid="vnc-prop-ok-reconnect"
              className="rounded border border-[var(--taomni-border)] px-4 py-1 hover:bg-[var(--taomni-bg-hover)]"
              onClick={() => onApply(draft, true)}
            >
              {t("vnc.propertiesOkReconnect")}
            </button>
          )}
          <button
            type="button"
            data-testid="vnc-prop-ok"
            className="rounded border border-[var(--taomni-border)] px-4 py-1 hover:bg-[var(--taomni-bg-hover)]"
            onClick={() => onApply(draft, false)}
          >
            {t("vnc.ok")}
          </button>
          <button
            type="button"
            data-testid="vnc-prop-cancel"
            className="rounded border border-[var(--taomni-border)] px-4 py-1 hover:bg-[var(--taomni-bg-hover)]"
            onClick={onClose}
          >
            {t("vnc.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
