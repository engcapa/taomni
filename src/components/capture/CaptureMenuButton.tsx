import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown } from "lucide-react";
import { useCaptureMenuItems, useCaptureAvailable } from "./captureMenuItems";
import { CaptureIndicators } from "./CaptureIndicators";
import { FT_ICON_BUTTON_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../lib/i18n";

// Detached windows have no tab strip (and therefore no `⋯` overflow), so the
// screenshot actions get their own small camera dropdown here. The main window
// folds the same actions into the tab-strip `⋯` menu instead.
export function CaptureMenuButton() {
  const t = useT();
  const available = useCaptureAvailable();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const items = useCaptureMenuItems(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!available) return null;

  return (
    <div className="flex items-center gap-1">
      <CaptureIndicators />
      <div ref={wrapRef} style={{ position: "relative" }}>
        <button
          type="button"
          data-testid="capture-menu"
          onClick={() => setOpen((v) => !v)}
          title={t("capture.menuTitle")}
          aria-label={t("capture.menuAria")}
          style={{ ...FT_ICON_BUTTON_STYLE, width: "auto", padding: "0 6px", gap: 2 }}
        >
          <Camera size={14} />
          <ChevronDown size={12} />
        </button>
        {open && (
          <div
            data-testid="capture-menu-dropdown"
            className="absolute rounded shadow-lg border text-[12px] py-1"
            style={{
              top: "100%",
              right: 0,
              marginTop: 2,
              minWidth: 200,
              zIndex: 50,
              background: "var(--taomni-panel-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text)",
            }}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`capture-${item.key}`}
                onClick={item.onClick}
                className="w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)]"
                style={item.active ? { color: "var(--taomni-accent)" } : undefined}
              >
                {item.icon}
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
