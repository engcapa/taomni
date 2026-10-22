import { useCallback, useLayoutEffect, useState, type CSSProperties } from "react";
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
  { label: string; className: string }
> = {
  allow_once: {
    label: "仅允许这一次",
    className: "border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10",
  },
  allow_always: {
    label: "始终允许",
    className: "border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10",
  },
  reject_once: {
    label: "拒绝这一次",
    className: "border border-red-500/50 text-red-300 hover:bg-red-500/10",
  },
  reject_always: {
    label: "始终拒绝",
    className: "border border-red-500/50 text-red-300 hover:bg-red-500/10",
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
  return (
    <div
      className="max-w-md w-full rounded-lg border border-yellow-500/50 bg-[var(--taomni-panel-bg)] p-3 shadow-md"
      data-testid="ai-chat-acp-permission-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-semibold">本地 Agent 请求执行操作</span>
        <span className="rounded border border-yellow-500/40 px-1.5 py-0.5 text-[10px] text-yellow-400">
          需要确认
        </span>
      </div>
      <div className="mb-1 text-[10px] text-[var(--taomni-text-muted)]">
        来源：本地 {prompt.sourceLabel}{isActiveThread ? "" : " · 后台对话"}
      </div>
      <div className="mb-1 text-[11px] text-[var(--taomni-text-muted)]">{prompt.title}</div>
      <div className="mb-2 text-[10px] text-[var(--taomni-text-muted)]">
        操作类型：{prompt.kind}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {prompt.options.map((option) => {
          const presentation = ACP_PERMISSION_OPTION_PRESENTATION[option.kind];
          return (
            <button
              key={option.optionId}
              type="button"
              className={`taomni-btn h-7 px-3 text-[12px] disabled:cursor-wait disabled:opacity-60 ${presentation.className}`}
              disabled={executing}
              data-testid={`ai-chat-acp-permission-option-${option.kind}`}
              onClick={() => onSelect(option.optionId)}
            >
              {presentation.label}
            </button>
          );
        })}
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px] text-[var(--taomni-text-muted)] disabled:cursor-wait disabled:opacity-60"
          disabled={executing}
          data-testid="ai-chat-acp-permission-cancel"
          onClick={onCancel}
        >
          取消操作
        </button>
      </div>
    </div>
  );
}
