import { useCallback, useEffect, useRef, useState } from "react";
import { Minimize2, Minus, Pin, PinOff, X } from "lucide-react";

import { useT } from "../../lib/i18n";
import { rdpNetworkQuality, type RdpNetworkInfo } from "../../lib/rdp";

const PINNED_KEY = "taomni.rdp.connectionBar.pinned";
/** Unpinned, the bar shows this long after connecting or being revealed. */
export const CONNECTION_BAR_REVEAL_MS = 2500;

function readPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

function writePinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, pinned ? "1" : "0");
  } catch {
    /* storage unavailable: the pin still applies to this session */
  }
}

export interface RdpConnectionBarProps {
  /** Host title shown in the middle, like mstsc's connection bar. */
  title: string;
  network: RdpNetworkInfo | null;
  /** Changing this shows the bar again (Ctrl+Alt+Home). */
  revealSignal: number;
  onCtrlAltDel: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onDisconnect: () => void;
}

const BAR_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  zIndex: 31,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 8px",
  borderRadius: "0 0 6px 6px",
  background: "rgba(24, 28, 34, 0.94)",
  color: "#e8ecf1",
  fontSize: 12,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.45)",
  transition: "transform 160ms ease",
};

const BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 26,
  height: 24,
  padding: "0 6px",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
};

/**
 * Full-screen connection bar (design §4.6, AC-15): pin, connection quality,
 * host title, Ctrl+Alt+Del, minimize, restore and disconnect. Unpinned it
 * slides away after {@link CONNECTION_BAR_REVEAL_MS}; pointing at the top
 * edge, focusing it with Tab or Ctrl+Alt+Home brings it back.
 */
export function RdpConnectionBar({
  title,
  network,
  revealSignal,
  onCtrlAltDel,
  onMinimize,
  onRestore,
  onDisconnect,
}: RdpConnectionBarProps) {
  const t = useT();
  const [pinned, setPinned] = useState(readPinned);
  const [shown, setShown] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<number | null>(null);

  const scheduleHide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(false);
    }, CONNECTION_BAR_REVEAL_MS);
  }, []);

  const reveal = useCallback(() => {
    setShown(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    reveal();
  }, [revealSignal, reveal]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const togglePinned = () => {
    const next = !pinned;
    setPinned(next);
    writePinned(next);
    if (!next) reveal();
  };

  const visible = pinned || shown || hovered || focused;
  const level = rdpNetworkQuality(network);
  const qualityText = !network
    ? t("rdp.bar.qualityUnknown")
    : typeof network.bandwidthKbps === "number"
      ? t("rdp.bar.qualityBandwidth", {
          level,
          rtt: network.averageRttMs,
          bandwidth: (network.bandwidthKbps / 1000).toFixed(1),
        })
      : t("rdp.bar.quality", { level, rtt: network.averageRttMs });

  return (
    <>
      <div
        data-testid="rdp-bar-hotzone"
        aria-hidden="true"
        onPointerEnter={reveal}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, zIndex: 30 }}
      />
      <div
        role="toolbar"
        aria-label={t("rdp.bar.label")}
        data-testid="rdp-connection-bar"
        data-visible={visible ? "true" : "false"}
        data-pinned={pinned ? "true" : "false"}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => {
          setHovered(false);
          scheduleHide();
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocused(false);
            scheduleHide();
          }
        }}
        style={{
          ...BAR_STYLE,
          transform: `translate(-50%, ${visible ? "0" : "calc(-100% + 3px)"})`,
        }}
      >
        <button
          type="button"
          data-testid="rdp-bar-pin"
          aria-pressed={pinned}
          aria-label={pinned ? t("rdp.bar.unpin") : t("rdp.bar.pin")}
          title={pinned ? t("rdp.bar.unpin") : t("rdp.bar.pin")}
          onClick={togglePinned}
          style={BUTTON_STYLE}
        >
          {pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
        <span
          role="img"
          data-testid="rdp-bar-quality"
          data-level={level}
          aria-label={qualityText}
          title={qualityText}
          style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14, padding: "0 4px" }}
        >
          {[1, 2, 3, 4].map((bar) => (
            <span
              key={bar}
              style={{
                width: 3,
                height: 3 + bar * 2.5,
                borderRadius: 1,
                background: bar <= level ? "#7ad37a" : "rgba(232, 236, 241, 0.28)",
              }}
            />
          ))}
        </span>
        <span
          data-testid="rdp-bar-title"
          style={{
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 10px",
            fontWeight: 600,
          }}
        >
          {title}
        </span>
        <button
          type="button"
          data-testid="rdp-bar-ctrl-alt-del"
          aria-label={t("rdp.ctrlAltDel")}
          title={t("rdp.ctrlAltDel")}
          onClick={onCtrlAltDel}
          style={BUTTON_STYLE}
        >
          Ctrl+Alt+Del
        </button>
        <button
          type="button"
          data-testid="rdp-bar-minimize"
          aria-label={t("rdp.bar.minimize")}
          title={t("rdp.bar.minimize")}
          onClick={onMinimize}
          style={BUTTON_STYLE}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          data-testid="rdp-bar-restore"
          aria-label={t("rdp.bar.restore")}
          title={t("rdp.bar.restore")}
          onClick={onRestore}
          style={BUTTON_STYLE}
        >
          <Minimize2 size={14} />
        </button>
        <button
          type="button"
          data-testid="rdp-bar-disconnect"
          aria-label={t("rdp.bar.disconnect")}
          title={t("rdp.bar.disconnect")}
          onClick={onDisconnect}
          style={BUTTON_STYLE}
        >
          <X size={14} />
        </button>
      </div>
    </>
  );
}
