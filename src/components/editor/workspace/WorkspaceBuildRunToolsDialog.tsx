import { useId, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ModalSurface } from "../../ui/ModalSurface";
import { ConfirmDialog } from "../../sidebar/ConfirmDialog";
import {
  DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
  type WorkspaceBuildRunTools,
} from "./codeWorkspaceModel";

interface WorkspaceBuildRunToolsDialogProps {
  config: WorkspaceBuildRunTools;
  onSave: (config: WorkspaceBuildRunTools) => void;
  onClose: () => void;
}

const TOOLS = [
  { id: "cargo", label: "Cargo", example: "cargo" },
  { id: "go", label: "Go", example: "go" },
  { id: "node", label: "Node.js", example: "node" },
  { id: "npm", label: "npm", example: "npm" },
  { id: "pnpm", label: "pnpm", example: "pnpm" },
  { id: "yarn", label: "Yarn", example: "yarn" },
  { id: "python", label: "Python", example: "python3, python.exe" },
  { id: "cmake", label: "CMake", example: "cmake" },
  { id: "dotnet", label: ".NET", example: "dotnet" },
  { id: "maven", label: "Maven", example: "mvn, mvn.cmd" },
  { id: "gradle", label: "Gradle", example: "gradle, gradle.bat" },
  { id: "sbt", label: "sbt", example: "sbt" },
  { id: "swift", label: "Swift", example: "swift" },
  { id: "lldbDap", label: "LLDB DAP", example: "lldb-dap" },
  { id: "delve", label: "Delve", example: "dlv" },
  { id: "debugpy", label: "debugpy", example: "debugpy-adapter" },
  { id: "jsDebug", label: "JS Debug", example: "js-debug-adapter" },
  { id: "netcoredbg", label: "CoreCLR", example: "netcoredbg" },
] as const;

export function WorkspaceBuildRunToolsDialog({
  config,
  onSave,
  onClose,
}: WorkspaceBuildRunToolsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    TOOLS.map(({ id }) => [id, config.tools[id]?.executable ?? ""]),
  ));
  const [mavenJvmArgs, setMavenJvmArgs] = useState(() => config.mavenRun.jvmArgs.join("\n"));
  const [inheritProjectJvmArgs, setInheritProjectJvmArgs] = useState(
    () => config.mavenRun.inheritProjectJvmArgs,
  );
  const [stepFiltersEnabled, setStepFiltersEnabled] = useState(
    () => config.stepFilters?.enabled ?? true,
  );
  const [stepFilterPatterns, setStepFilterPatterns] = useState(
    () => (config.stepFilters?.patterns ?? DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS.patterns).join("\n"),
  );
  const [skipSynthetics, setSkipSynthetics] = useState(
    () => config.stepFilters?.skipSynthetics ?? true,
  );
  const [skipStaticInitializers, setSkipStaticInitializers] = useState(
    () => config.stepFilters?.skipStaticInitializers ?? false,
  );
  const [skipConstructors, setSkipConstructors] = useState(
    () => config.stepFilters?.skipConstructors ?? false,
  );

  const t = useT();
  const titleId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const originalFilters = config.stepFilters ?? DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS;
  const dirty = TOOLS.some(({ id }) => values[id] !== (config.tools[id]?.executable ?? ""))
    || mavenJvmArgs !== config.mavenRun.jvmArgs.join("\n")
    || inheritProjectJvmArgs !== config.mavenRun.inheritProjectJvmArgs
    || stepFiltersEnabled !== originalFilters.enabled || stepFilterPatterns !== originalFilters.patterns.join("\n")
    || skipSynthetics !== originalFilters.skipSynthetics || skipStaticInitializers !== originalFilters.skipStaticInitializers
    || skipConstructors !== originalFilters.skipConstructors;

  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  return <>
    <ModalSurface initialFocus='[data-testid="workspace-tool-cargo"]' onCancel={requestClose}
      aria-labelledby={titleId} data-testid="workspace-build-run-tools-dialog" className="taomni-modal"
      style={{ width: "min(620px, calc(100vw - 32px))" }}>
        <header className="flex items-center gap-2">
          <h2 id={titleId} className="text-ui-title font-semibold">{t("buildRunTools.title")}</h2>
          {dirty && <span className="text-ui-small text-[var(--taomni-text-muted)]">{t("buildRunTools.unsaved")}</span>}
          <IconButton data-testid="workspace-build-run-tools-close" label={t("buildRunTools.close")}
            className="taomni-btn ml-auto h-7 w-7" onClick={requestClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="taomni-modal-body max-h-[min(72vh,680px)] space-y-3 text-ui-body">
          <p className="text-[var(--taomni-code-muted)]">
            {t("buildRunTools.discovery")}
          </p>
          {TOOLS.map((tool) => (
            <label key={tool.id} className="grid grid-cols-[92px_1fr] items-center gap-2">
              <span>{tool.label}</span>
              <input
                data-testid={`workspace-tool-${tool.id}`}
                aria-label={t("buildRunTools.executable", { tool: tool.label })}
                value={values[tool.id]}
                placeholder={t("buildRunTools.pathHint", { example: tool.example })}
                onChange={(event) => setValues((current) => ({ ...current, [tool.id]: event.target.value }))}
                className="taomni-input min-w-0"
              />
            </label>
          ))}
          <div className="space-y-1 pt-1">
            <label className="block" htmlFor="workspace-maven-run-jvm-args">{t("buildRunTools.jvmLabel")}</label>
            <textarea
              id="workspace-maven-run-jvm-args"
              data-testid="workspace-maven-run-jvm-args"
              aria-label={t("buildRunTools.jvmLabel")}
              value={mavenJvmArgs}
              placeholder={t("buildRunTools.jvmPlaceholder")}
              onChange={(event) => setMavenJvmArgs(event.target.value)}
              rows={4}
              className="taomni-input block w-full resize-y font-mono text-ui-small"
            />
            <p className="text-[var(--taomni-code-muted)]">
              {t("buildRunTools.jvmHint")}
              {" "}
              <code>--add-opens=java.base/sun.nio.ch=ALL-UNNAMED</code>.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox" className="taomni-checkbox"
              data-testid="workspace-maven-inherit-argline"
              checked={inheritProjectJvmArgs}
              onChange={(event) => setInheritProjectJvmArgs(event.target.checked)}
            />
            <span>{t("buildRunTools.inherit")}</span>
          </label>

          <div className="border-t border-[var(--taomni-code-border)] pt-3 space-y-2">
            <div className="font-medium">{t("buildRunTools.filters")}</div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox" className="taomni-checkbox"
                data-testid="workspace-debug-step-filters-enabled"
                checked={stepFiltersEnabled}
                onChange={(e) => setStepFiltersEnabled(e.target.checked)}
              />
              <span>{t("buildRunTools.enableFilters")}</span>
            </label>
            {stepFiltersEnabled && (
              <>
                <label className="block text-ui-small text-[var(--taomni-code-muted)]" htmlFor="workspace-debug-step-filter-patterns">
                  {t("buildRunTools.patternHint")} <code>java.*, javax.*, sun.*, com.sun.*</code>
                </label>
                <textarea
                  id="workspace-debug-step-filter-patterns"
                  data-testid="workspace-debug-step-filter-patterns"
                  aria-label={t("buildRunTools.patterns")}
                  value={stepFilterPatterns}
                  onChange={(e) => setStepFilterPatterns(e.target.value)}
                  rows={4}
                  className="taomni-input block w-full resize-y font-mono text-ui-small"
                />
                <div className="flex flex-wrap gap-4 pt-1">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox" className="taomni-checkbox"
                      data-testid="workspace-debug-skip-synthetics"
                      checked={skipSynthetics}
                      onChange={(e) => setSkipSynthetics(e.target.checked)}
                    />
                    <span>{t("buildRunTools.synthetics")}</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox" className="taomni-checkbox"
                      data-testid="workspace-debug-skip-static-init"
                      checked={skipStaticInitializers}
                      onChange={(e) => setSkipStaticInitializers(e.target.checked)}
                    />
                    <span>{t("buildRunTools.initializers")}</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox" className="taomni-checkbox"
                      data-testid="workspace-debug-skip-constructors"
                      checked={skipConstructors}
                      onChange={(e) => setSkipConstructors(e.target.checked)}
                    />
                    <span>{t("buildRunTools.constructors")}</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="taomni-modal-footer">
          <Button
            data-testid="workspace-build-run-tools-cancel"
            className="taomni-btn h-7 px-3"
            onClick={requestClose}
          >{t("common.cancel")}</Button>
          <Button
            variant="primary" data-testid="workspace-build-run-tools-save"
            className="taomni-btn h-7 px-3"
            onClick={() => {
              const tools = { ...config.tools };
              for (const { id } of TOOLS) {
                const executable = values[id].trim();
                if (executable) tools[id] = { executable };
                else delete tools[id];
              }
              onSave({
                tools,
                mavenRun: {
                  jvmArgs: mavenJvmArgs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
                  inheritProjectJvmArgs,
                },
                stepFilters: {
                  enabled: stepFiltersEnabled,
                  patterns: stepFilterPatterns.split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
                  skipSynthetics,
                  skipStaticInitializers,
                  skipConstructors,
                },
              });
            }}
          >
            {t("common.save")}
          </Button>
        </div>
    </ModalSurface>
    {confirmDiscard && <ConfirmDialog danger title={t("buildRunTools.discardTitle")} message={t("buildRunTools.discardMessage")}
      cancelLabel={t("buildRunTools.keepEditing")} confirmLabel={t("buildRunTools.discard")}
      onCancel={() => setConfirmDiscard(false)} onConfirm={onClose} />}
  </>;
}
