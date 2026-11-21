export function GitCloneProgressBar({
  percent,
  indeterminate,
}: {
  percent: number | null;
  indeterminate: boolean;
}) {
  const value = percent === null ? undefined : Math.max(0, Math.min(100, percent));
  return (
    <div
      data-testid="workspace-git-clone-progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      aria-valuetext={value === undefined ? undefined : `${Math.round(value)}%`}
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--taomni-input-bg, #0b1220)" }}
    >
      {indeterminate || value === undefined ? (
        <div className="h-full w-1/3 animate-pulse rounded-full" style={{ background: "var(--taomni-accent)" }} />
      ) : (
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${value}%`, background: "var(--taomni-accent)" }} />
      )}
    </div>
  );
}
