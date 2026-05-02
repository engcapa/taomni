import { ArrowLeft, ArrowRight, ArrowUp, RefreshCw, FolderPlus, Eye, EyeOff, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";

interface FileToolbarProps {
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  showHidden: boolean;
  loading?: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onMkdir: () => void;
  onDetach?: () => void;
  rightExtras?: ReactNode;
}

export function FileToolbar({
  canBack,
  canForward,
  canUp,
  showHidden,
  loading,
  onBack,
  onForward,
  onUp,
  onRefresh,
  onToggleHidden,
  onMkdir,
  onDetach,
  rightExtras,
}: FileToolbarProps) {
  return (
    <div className="h-6 flex items-center gap-0.5 px-1 border-b shrink-0"
      style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
      <ToolBtn title="Back" disabled={!canBack} onClick={onBack}>
        <ArrowLeft className="w-3 h-3" />
      </ToolBtn>
      <ToolBtn title="Forward" disabled={!canForward} onClick={onForward}>
        <ArrowRight className="w-3 h-3" />
      </ToolBtn>
      <ToolBtn title="Up" disabled={!canUp} onClick={onUp}>
        <ArrowUp className="w-3 h-3" />
      </ToolBtn>
      <span className="moba-divider-v h-3 mx-0.5" />
      <ToolBtn title="Refresh" onClick={onRefresh}>
        <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
      </ToolBtn>
      <ToolBtn title="Create folder" onClick={onMkdir}>
        <FolderPlus className="w-3 h-3" />
      </ToolBtn>
      <ToolBtn
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        onClick={onToggleHidden}
      >
        {showHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </ToolBtn>
      {onDetach && (
        <ToolBtn title="Detach to its own window" onClick={onDetach}>
          <Maximize2 className="w-3 h-3" />
        </ToolBtn>
      )}
      <div className="flex-1" />
      {rightExtras}
    </div>
  );
}

function ToolBtn({
  children,
  title,
  onClick,
  disabled,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-40 disabled:cursor-default"
    >
      {children}
    </button>
  );
}
