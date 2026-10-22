import { type MouseEvent, type ReactNode } from "react";
import type { DbColumn } from "../../../lib/ipc";


export function ToolButton({
  title,
  icon,
  suffix,
  disabled,
  active,
  onClick,
}: {
  title: string;
  icon: ReactNode;
  suffix?: ReactNode;
  disabled?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`h-6 ${suffix ? "px-1.5" : "w-6"} inline-flex items-center justify-center gap-0.5 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40`}
      style={active ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {suffix}
    </button>
  );
}


export function Divider() {
  return <span className="w-px h-4 mx-0.5" style={{ background: "var(--taomni-divider)" }} />;
}


export function StatsCell({ children, header = false }: { children: ReactNode; header?: boolean }) {
  return (
    <div
      className={`px-2 py-1 truncate ${header ? "font-semibold text-[var(--taomni-text)]" : "text-[var(--taomni-text-muted)]"}`}
      style={{ borderRight: "1px solid var(--taomni-divider)", borderBottom: "1px solid var(--taomni-divider)" }}
      title={typeof children === "string" ? children : undefined}
    >
      {children}
    </div>
  );
}


export function FragmentStats({
  stat,
}: {
  stat: {
    column: DbColumn;
    count: number;
    nulls: number;
    distinct: number;
    min: string | number;
    max: string | number;
    avg: number | null;
  };
}) {
  return (
    <>
      <StatsCell>{stat.column.name}</StatsCell>
      <StatsCell>{stat.count}</StatsCell>
      <StatsCell>{stat.nulls}</StatsCell>
      <StatsCell>{stat.distinct}</StatsCell>
      <StatsCell>{String(stat.min)}</StatsCell>
      <StatsCell>{String(stat.max)}</StatsCell>
      <StatsCell>{stat.avg === null ? "" : stat.avg.toFixed(3)}</StatsCell>
    </>
  );
}
