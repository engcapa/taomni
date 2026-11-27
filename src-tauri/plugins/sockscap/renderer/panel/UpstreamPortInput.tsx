import { useState } from "react";

interface Props {
  port?: number;
  disabled: boolean;
  title?: string;
  onPortChange: (port: number) => void;
}

export function UpstreamPortInput({ port, disabled, title, onPortChange }: Props) {
  const [incomplete, setIncomplete] = useState<string | null>(null);
  return (
    <input
      data-testid="sockscap-upstream-port"
      name="upstreamPort"
      type="number"
      min={1}
      max={65535}
      className="w-full text-ui-body px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
      value={incomplete ?? port ?? ""}
      disabled={disabled}
      title={title}
      onChange={({ currentTarget }) => {
        if (!currentTarget.value || !currentTarget.validity.valid) {
          setIncomplete(currentTarget.value);
          return;
        }
        setIncomplete(null);
        if (currentTarget.valueAsNumber !== port) onPortChange(currentTarget.valueAsNumber);
      }}
      onBlur={({ currentTarget }) => {
        if (incomplete === "" && !currentTarget.validity.badInput && port !== 1080) onPortChange(1080);
        setIncomplete(null);
      }}
    />
  );
}
