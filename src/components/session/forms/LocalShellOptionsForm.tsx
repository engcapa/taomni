import type { CSSProperties } from "react";
import { useMemo } from "react";
import { useT } from "../../../lib/i18n";
import type { LocalShellOption } from "../../../lib/ipc";
import { shellArgsToText, type LocalShellOptions } from "../../../types/localShell";

export interface LocalShellOptionsFormProps {
  options: LocalShellOptions;
  shells: LocalShellOption[];
  status: "loading" | "ready" | "error";
  onChange: (next: LocalShellOptions) => void;
}

const DEFAULT_VALUE = "__default__";
const CUSTOM_VALUE = "__custom__";

export function LocalShellOptionsForm({
  options,
  shells,
  status,
  onChange,
}: LocalShellOptionsFormProps) {
  const t = useT();
  const selectedShell = useMemo(
    () => shells.find((shell) => shell.path === options.shellPath),
    [options.shellPath, shells],
  );
  const selectValue = options.shellPath ? selectedShell?.path ?? CUSTOM_VALUE : DEFAULT_VALUE;

  const update = (patch: Partial<LocalShellOptions>) => onChange({ ...options, ...patch });

  const handleSelect = (value: string) => {
    if (value === DEFAULT_VALUE) {
      onChange({ shellPath: "", shellArgsText: "" });
      return;
    }
    if (value === CUSTOM_VALUE) {
      update({ shellPath: selectedShell ? "" : options.shellPath });
      return;
    }
    const shell = shells.find((item) => item.path === value);
    if (!shell) return;
    onChange({
      shellPath: shell.path,
      shellArgsText: shellArgsToText(shell.args),
    });
  };

  return (
    <div data-testid="session-local-shell-section" style={{ display: "grid", gap: 12 }}>
      <fieldset>
        <legend>{t("sessionEditor2.localShellTitle")}</legend>

        <label style={row()}>
          <span>{t("sessionEditor2.localShellSelectLabel")}</span>
          <select
            data-testid="local-shell-select"
            className="taomni-input"
            value={selectValue}
            aria-label={t("sessionEditor2.localShellSelectLabel")}
            onChange={(event) => handleSelect(event.target.value)}
          >
            <option value={DEFAULT_VALUE}>{t("sessionEditor2.localShellDefault")}</option>
            {shells.map((shell) => (
              <option key={`${shell.name}:${shell.path}`} value={shell.path}>
                {shell.name}{shell.isDefault ? t("sessionEditor2.localShellDefaultMarker") : ""}
              </option>
            ))}
            <option value={CUSTOM_VALUE}>{t("sessionEditor2.localShellCustom")}</option>
          </select>
        </label>

        {status === "loading" && <div style={hint()}>{t("sessionEditor2.localShellDetecting")}</div>}
        {status === "error" && <div style={hint()}>{t("sessionEditor2.localShellDetectFailed")}</div>}
        {status === "ready" && shells.length === 0 && (
          <div style={hint()}>{t("sessionEditor2.localShellNoDetected")}</div>
        )}

        <label style={row()}>
          <span>{t("sessionEditor2.localShellPathLabel")}</span>
          <input
            data-testid="local-shell-path"
            className="taomni-input"
            type="text"
            value={options.shellPath}
            placeholder={t("sessionEditor2.localShellPathPlaceholder")}
            aria-label={t("sessionEditor2.localShellPathLabel")}
            onChange={(event) => update({ shellPath: event.target.value })}
          />
        </label>

        <label style={row()}>
          <span>{t("sessionEditor2.localShellArgsLabel")}</span>
          <input
            data-testid="local-shell-args"
            className="taomni-input"
            type="text"
            value={options.shellArgsText}
            placeholder={t("sessionEditor2.localShellArgsPlaceholder")}
            aria-label={t("sessionEditor2.localShellArgsLabel")}
            onChange={(event) => update({ shellArgsText: event.target.value })}
          />
        </label>
        <div style={hint()}>{t("sessionEditor2.localShellArgsHint")}</div>
      </fieldset>

      <fieldset>
        <legend>{t("sessionEditor2.localShellPreview")}</legend>
        <code
          data-testid="local-shell-preview"
          style={{
            display: "block",
            padding: "8px 10px",
            background: "var(--taomni-input-bg)",
            border: "1px solid var(--taomni-divider)",
            borderRadius: 4,
            color: "var(--taomni-text)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {previewText(options)}
        </code>
      </fieldset>
    </div>
  );
}

function previewText(options: LocalShellOptions): string {
  const path = options.shellPath.trim();
  if (!path) return "default shell";
  const args = options.shellArgsText.trim();
  return args ? `${path} ${args}` : path;
}

function row(): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "150px minmax(0, 1fr)",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
  };
}

function hint(): CSSProperties {
  return {
    fontSize: 11,
    color: "var(--taomni-text-muted)",
    marginLeft: 158,
    marginBottom: 4,
  };
}
