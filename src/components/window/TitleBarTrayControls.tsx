import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal, SplitSquareVertical, Users } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { useViewportSize } from "../../hooks/useViewportSize";
import { useVoiceSettingsStore } from "../voice/VoiceSettingsDialog";
import { PttButton } from "./PttButton";

const COMPACT_TITLEBAR_BREAKPOINT = 960;

export function TitleBarTrayControls({ compact = false, layoutActions = true }: { compact?: boolean; layoutActions?: boolean } = {}) {
  const terminalSplitActive = useAppStore((s) => s.terminalSplitActive);
  const multiExecActive = useAppStore((s) => s.multiExecActive);
  const toggleTerminalSplit = useAppStore((s) => s.toggleTerminalSplit);
  const toggleMultiExec = useAppStore((s) => s.toggleMultiExec);
  const aiFullyDisabled = useAiStore((s) => s.config?.fully_disabled === true);
  const t = useT();

  const splitTitle = terminalSplitActive ? t("titlebar.disableSplit") : t("titlebar.enableSplit");
  const multiExecTitle = multiExecActive ? t("titlebar.disableMultiExec") : t("titlebar.enableMultiExec");
  const { width } = useViewportSize();
  const trayProps: TrayProps = {
    layoutActions,
    terminalSplitActive,
    multiExecActive,
    toggleTerminalSplit,
    toggleMultiExec,
    aiFullyDisabled,
    splitTitle,
    multiExecTitle,
  };

  return compact || width <= COMPACT_TITLEBAR_BREAKPOINT
    ? <CompactTitleBarTray {...trayProps} />
    : (
    <div className="taomni-titlebar-tray flex items-stretch self-stretch shrink-0" data-testid="titlebar-tray">
      {/* Terminal layout group */}
      <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
        <TrayButton
          testId="tab-split-view"
          title={splitTitle}
          ariaLabel={splitTitle}
          active={terminalSplitActive}
          onClick={toggleTerminalSplit}
        >
          <SplitSquareVertical className="w-[16px] h-[16px]" />
        </TrayButton>
        <TrayButton
          testId="tab-multiexec-toggle"
          title={multiExecTitle}
          ariaLabel={multiExecTitle}
          active={multiExecActive}
          onClick={toggleMultiExec}
        >
          <Users className="w-[16px] h-[16px]" />
        </TrayButton>
      </div>

      {!aiFullyDisabled && (
        <>
          <TrayGroupSeparator />
          <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
            <PttButton />
          </div>
        </>
      )}

    </div>
    );
}

interface TrayProps {
  layoutActions: boolean;
  terminalSplitActive: boolean;
  multiExecActive: boolean;
  toggleTerminalSplit: () => void;
  toggleMultiExec: () => void;
  aiFullyDisabled: boolean;
  splitTitle: string;
  multiExecTitle: string;
}

function CompactTitleBarTray({
  layoutActions,
  terminalSplitActive,
  multiExecActive,
  toggleTerminalSplit,
  toggleMultiExec,
  aiFullyDisabled,
  splitTitle,
  multiExecTitle,
}: TrayProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const voiceSettingsOpen = useVoiceSettingsStore((s) => s.open);
  useEffect(() => { if (voiceSettingsOpen) setOpen(false); }, [voiceSettingsOpen]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 4 });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 4,
        right: Math.max(4, window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        anchorRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        target?.closest("[data-taomni-context-menu]")
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <>
      <div ref={anchorRef} className="taomni-titlebar-actions-overflow relative flex items-stretch self-stretch shrink-0">
        <button
          type="button"
          data-testid="titlebar-actions-more"
          title={t("titlebar.moreActions")}
          aria-label={t("titlebar.moreActions")}
          aria-haspopup="menu"
          aria-expanded={open}
          className="taomni-titlebar-tray-btn h-full w-9 inline-flex items-center justify-center hover:bg-[var(--taomni-hover)]"
          style={{ color: "var(--taomni-text)" }}
          onClick={() => setOpen((visible) => !visible)}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          data-testid="titlebar-actions-menu"
          data-taomni-context-menu=""
          role="menu"
          className="taomni-titlebar-actions-menu fixed z-[9999] min-w-[236px] rounded shadow-lg border py-1 text-[12px]"
          style={{
            top: position.top,
            right: position.right,
            background: "var(--taomni-panel-bg)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          {layoutActions && <>
          <CompactActionButton
            testId="tab-split-view"
            title={splitTitle}
            active={terminalSplitActive}
            icon={<SplitSquareVertical className="w-4 h-4" />}
            onClick={() => run(toggleTerminalSplit)}
          />
          <CompactActionButton
            testId="tab-multiexec-toggle"
            title={multiExecTitle}
            active={multiExecActive}
            icon={<Users className="w-4 h-4" />}
            onClick={() => run(toggleMultiExec)}
          />
          </>}
          {!aiFullyDisabled && (
            <div className="flex items-center justify-between gap-3 px-3 py-1">
              <span className="truncate">{t("voice.start")}</span>
              <PttButton />
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function CompactActionButton({
  testId,
  title,
  icon,
  active,
  onClick,
  ariaLabel,
}: {
  testId: string;
  title: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      title={title}
      aria-label={ariaLabel ?? title}
      data-active={active || undefined}
      className="w-full min-h-7 px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
      onClick={onClick}
    >
      <span className="w-4 shrink-0 inline-flex items-center justify-center">{icon}</span>
      <span className="truncate">{title}</span>
    </button>
  );
}

function TrayGroupSeparator() {
  return (
    <div
      aria-hidden="true"
      className="taomni-titlebar-tray-group-sep self-stretch shrink-0"
    />
  );
}

function TrayButton({
  children,
  title,
  ariaLabel,
  onClick,
  active,
  testId,
}: {
  children: React.ReactNode;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      data-active={active || undefined}
      className="taomni-titlebar-tray-btn h-full w-10 inline-flex items-center justify-center hover:bg-[var(--taomni-hover)]"
      style={{ color: "var(--taomni-text)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
