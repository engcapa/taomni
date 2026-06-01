/**
 * WSL-specific options panel rendered inside `SessionEditor` when the
 * selected protocol is WSL. The form reads/writes a normalized
 * [`WslOptions`] tree which `SessionEditor.buildConfig` mirrors into
 * `localShellPath`/`localShellArgs` so the existing local-terminal pipeline
 * launches the saved session unchanged.
 */
import { useT } from "../../../lib/i18n";
import { selectFolderPath } from "../../../lib/ipc";
import { buildWslLaunchArgs, DEFAULT_WSL_OPTIONS, type WslOptions } from "../../../types/wsl";
import type { WslDistro } from "../../../lib/ipc";

export interface WslOptionsFormProps {
  options: WslOptions;
  distros: WslDistro[];
  status: "loading" | "ready" | "error" | "unsupported";
  onChange: (next: WslOptions) => void;
}

export function WslOptionsForm({ options, distros, status, onChange }: WslOptionsFormProps) {
  const t = useT();
  const opt = { ...DEFAULT_WSL_OPTIONS, ...options };
  const set = (patch: Partial<WslOptions>) => onChange({ ...opt, ...patch });

  const distroInList = distros.some((d) => d.name === opt.distro);
  const showFreeText = !distroInList || status !== "ready";
  const previewArgs = buildWslLaunchArgs(opt);

  const handleBrowseCwd = async () => {
    try {
      const picked = await selectFolderPath();
      if (picked) set({ cwd: picked });
    } catch {
      // user cancelled or picker unavailable — silent
    }
  };

  return (
    <div className="wsl-options-form" style={{ display: "grid", gap: 12 }}>
      <fieldset>
        <legend>{t("wsl.options.title")}</legend>

        <label style={row()}>
          <span>{t("wsl.options.distro")}</span>
          {status === "ready" && distros.length > 0 ? (
            <select
              data-testid="wsl-distro"
              className="taomni-input"
              value={distroInList ? opt.distro : ""}
              onChange={(e) => set({ distro: e.target.value })}
            >
              <option value="">—</option>
              {distros.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}{d.isDefault ? t("wsl.options.defaultMarker") : ""}
                </option>
              ))}
            </select>
          ) : null}
          {showFreeText && (
            <input
              data-testid="wsl-distro-text"
              className="taomni-input"
              type="text"
              value={opt.distro}
              placeholder={t("wsl.options.distroPlaceholder")}
              aria-label={t("wsl.options.distroFreeText")}
              onChange={(e) => set({ distro: e.target.value })}
            />
          )}
        </label>

        {status === "loading" && (
          <div style={hint()}>{t("wsl.options.detecting")}</div>
        )}
        {status === "unsupported" && (
          <div data-testid="wsl-status-unsupported" style={hint()}>
            {t("wsl.options.unsupported")}
          </div>
        )}
        {status === "ready" && distros.length === 0 && (
          <div style={hint()}>{t("wsl.options.noDistros")}</div>
        )}

        <label style={row()}>
          <span>{t("wsl.options.user")}</span>
          <input
            data-testid="wsl-user"
            className="taomni-input"
            type="text"
            value={opt.user ?? ""}
            placeholder={t("wsl.options.userPlaceholder")}
            onChange={(e) => set({ user: e.target.value || undefined })}
          />
        </label>

        <label style={row()}>
          <span>{t("wsl.options.cwd")}</span>
          <input
            data-testid="wsl-cwd"
            className="taomni-input"
            type="text"
            value={opt.cwd ?? ""}
            placeholder={t("wsl.options.cwdPlaceholder")}
            onChange={(e) => set({ cwd: e.target.value || undefined })}
          />
          <button
            type="button"
            className="taomni-btn"
            onClick={() => void handleBrowseCwd()}
          >
            {t("wsl.options.cwdBrowse")}
          </button>
        </label>

        <label style={row()}>
          <span>{t("wsl.options.initialCommand")}</span>
          <input
            data-testid="wsl-initial-cmd"
            className="taomni-input"
            type="text"
            value={opt.initialCommand ?? ""}
            placeholder={t("wsl.options.initialCommandPlaceholder")}
            onChange={(e) => set({ initialCommand: e.target.value || undefined })}
          />
        </label>
        <div style={hint()}>{t("wsl.options.initialCommandHint")}</div>

        <label style={row()}>
          <input
            data-testid="wsl-admin"
            type="checkbox"
            className="taomni-checkbox"
            checked={opt.asAdministrator ?? false}
            onChange={(e) => set({ asAdministrator: e.target.checked || undefined })}
          />
          <span>{t("wsl.options.asAdministrator")}</span>
        </label>
        <div style={hint()}>{t("wsl.options.asAdministratorHint")}</div>
      </fieldset>

      <fieldset>
        <legend>{t("wsl.options.argvPreview")}</legend>
        <code
          data-testid="wsl-argv-preview"
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
          {previewArgs.length === 0
            ? "wsl.exe"
            : `wsl.exe ${previewArgs.map(quoteIfNeeded).join(" ")}`}
        </code>
      </fieldset>
    </div>
  );
}

function quoteIfNeeded(arg: string): string {
  return /\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function row(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
  };
}

function hint(): React.CSSProperties {
  return {
    fontSize: 11,
    color: "var(--taomni-text-muted)",
    marginLeft: 8,
    marginBottom: 4,
  };
}
