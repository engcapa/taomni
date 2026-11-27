

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="sockscap-field block text-ui-small">
      <div className="sockscap-field-label text-[var(--taomni-text-muted)] mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}
