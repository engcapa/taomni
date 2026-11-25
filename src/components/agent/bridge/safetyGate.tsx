import { useCallback, useLayoutEffect, useState, type CSSProperties } from "react";
import { useT } from "../../../lib/i18n";
import { type AcpPermissionOption, type QueuedPermission } from "./types";

export const SAFETY_GATE_DRAWER_SELECTOR = '[data-testid="ai-chat-drawer"]';

export const SAFETY_GATE_INSET = 12;

export const SAFETY_GATE_VIEWPORT_MARGIN = 16;

export const SAFETY_GATE_MAX_WIDTH = 420;

export const SAFETY_GATE_MIN_WIDTH = 260;


export interface SafetyGatePlacement {
  anchored: boolean;
  style: CSSProperties;
}


export function viewportSafetyGatePlacement(): SafetyGatePlacement {
  return {
    anchored: false,
    style: {
      right: SAFETY_GATE_VIEWPORT_MARGIN,
      bottom: SAFETY_GATE_VIEWPORT_MARGIN,
      width: `min(calc(100vw - ${SAFETY_GATE_VIEWPORT_MARGIN * 2}px), ${SAFETY_GATE_MAX_WIDTH}px)`,
    },
  };
}


export function computeSafetyGatePlacement(): SafetyGatePlacement {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return viewportSafetyGatePlacement();
  }
  const drawer = document.querySelector<HTMLElement>(SAFETY_GATE_DRAWER_SELECTOR);
  if (!drawer) return viewportSafetyGatePlacement();
  const rect = drawer.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return viewportSafetyGatePlacement();
  const width = Math.min(
    SAFETY_GATE_MAX_WIDTH,
    Math.max(SAFETY_GATE_MIN_WIDTH, rect.width - SAFETY_GATE_INSET * 2),
  );
  return {
    anchored: true,
    style: {
      right: Math.max(
        SAFETY_GATE_VIEWPORT_MARGIN,
        window.innerWidth - rect.right + SAFETY_GATE_INSET,
      ),
      bottom: Math.max(
        SAFETY_GATE_VIEWPORT_MARGIN,
        window.innerHeight - rect.bottom + SAFETY_GATE_INSET,
      ),
      width,
    },
  };
}


export function useSafetyGatePlacement(active: boolean): SafetyGatePlacement {
  const [placement, setPlacement] = useState<SafetyGatePlacement>(viewportSafetyGatePlacement);
  const updatePlacement = useCallback(() => {
    setPlacement(computeSafetyGatePlacement());
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    let resizeObserver: ResizeObserver | null = null;
    const drawer = document.querySelector<HTMLElement>(SAFETY_GATE_DRAWER_SELECTOR);
    if (drawer && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updatePlacement);
      resizeObserver.observe(drawer);
    }
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
      resizeObserver?.disconnect();
    };
  }, [active, updatePlacement]);

  return active ? placement : viewportSafetyGatePlacement();
}


export const ACP_PERMISSION_OPTION_PRESENTATION: Record<
  AcpPermissionOption["kind"],
  { labelKey: string; className: string }
> = {
  allow_once: {
    labelKey: "agent.allowOnce",
    className: "border border-ui-success-border text-ui-success hover:bg-ui-success-surface",
  },
  allow_always: {
    labelKey: "agent.allowAlways",
    className: "border border-ui-success-border text-ui-success hover:bg-ui-success-surface",
  },
  reject_once: {
    labelKey: "agent.rejectOnce",
    className: "border border-ui-danger-border text-ui-danger hover:bg-ui-danger-surface",
  },
  reject_always: {
    labelKey: "agent.rejectAlways",
    className: "border border-ui-danger-border text-ui-danger hover:bg-ui-danger-surface",
  },
};


export function AcpPermissionCard({
  prompt,
  executing,
  isActiveThread,
  onSelect,
  onCancel,
}: {
  prompt: Extract<QueuedPermission, { source: "acp" }>;
  executing: boolean;
  isActiveThread: boolean;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      className="max-w-md w-full rounded border border-ui-warning-border bg-[var(--taomni-panel-bg)] p-3 shadow-[var(--taomni-shadow-md)]"
      aria-busy={executing || undefined}
      data-testid="ai-chat-acp-permission-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ui-body font-semibold">{t("agent.localApprovalTitle")}</span>
        <span className="rounded border border-ui-warning-border px-1.5 py-0.5 text-ui-caption text-ui-warning">
          {t("agent.confirmationRequired")}
        </span>
      </div>
      <div className="mb-1 text-ui-caption text-[var(--taomni-text-muted)]">
        {t(isActiveThread ? "agent.activeApprovalSource" : "agent.backgroundApprovalSource", { name: prompt.sourceLabel })}
      </div>
      <div className="mb-1 text-ui-small text-[var(--taomni-text-muted)]">{prompt.title}</div>
      <div className="mb-2 text-ui-caption text-[var(--taomni-text-muted)]">
        {t("agent.approvalOperation", { kind: prompt.kind })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {prompt.options.map((option) => {
          const presentation = ACP_PERMISSION_OPTION_PRESENTATION[option.kind];
          return (
            <button
              key={option.optionId}
              type="button"
              className={`taomni-btn h-7 px-3 text-ui-body disabled:cursor-wait disabled:opacity-60 ${presentation.className}`}
              disabled={executing}
              data-testid={`ai-chat-acp-permission-option-${option.kind}`}
              onClick={() => onSelect(option.optionId)}
            >
              {t(presentation.labelKey)}
            </button>
          );
        })}
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-ui-body text-[var(--taomni-text-muted)] disabled:cursor-wait disabled:opacity-60"
          disabled={executing}
          data-testid="ai-chat-acp-permission-cancel"
          onClick={onCancel}
        >
          {t("agent.cancelOperation")}
        </button>
      </div>
    </div>
  );
}
