import { IconButton } from "../../ui/IconButton";
import { useEffect, useId, useState } from "react";
import { Settings2, RotateCcw, Save, X } from "lucide-react";
import {
  ALLOWED_TEMPLATE_VARIABLES,
  DEFAULT_JAVA_TEMPLATES,
  type JavaTemplateKind,
} from "./fileTemplateModel";
import {
  loadJavaTemplatePreferences,
  resetJavaTemplatePreferences,
  saveJavaTemplatePreferences,
} from "../../../lib/fileTemplatePreferences";

export interface FileTemplateSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const TEMPLATE_TABS: { kind: JavaTemplateKind; label: string }[] = [
  { kind: "class", label: "Class" },
  { kind: "interface", label: "Interface" },
  { kind: "record", label: "Record" },
  { kind: "enum", label: "Enum" },
  { kind: "annotation", label: "Annotation" },
];

export function FileTemplateSettingsDialog({ open, onClose }: FileTemplateSettingsDialogProps) {
  const [activeKind, setActiveKind] = useState<JavaTemplateKind>("class");
  const [templates, setTemplates] = useState<Record<JavaTemplateKind, string>>({
    ...DEFAULT_JAVA_TEMPLATES,
  });
  const [savedNotice, setSavedNotice] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      const prefs = loadJavaTemplatePreferences();
      setTemplates({ ...prefs.templates });
      setActiveKind("class");
      setSavedNotice(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    saveJavaTemplatePreferences({ templates });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleReset = () => {
    const defaults = resetJavaTemplatePreferences();
    setTemplates({ ...defaults.templates });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="file-template-settings-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 taomni-dialog-backdrop flex items-start justify-center p-4 pt-[10vh]"
    >
      <div className="flex w-full max-w-2xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-ui-body text-[var(--taomni-code-text)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-2.5">
          <div className="flex items-center gap-2 font-medium">
            <Settings2 className="h-4 w-4 text-ui-info" />
            <span id={titleId}>File and Code Templates</span>
          </div>
          <IconButton labelKey="close"
            type="button"
            onClick={onClose}
            data-testid="file-template-close-button"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-[var(--taomni-code-border)] px-4 bg-[var(--taomni-code-active-line-bg)]/30">
          {TEMPLATE_TABS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              onClick={() => setActiveKind(tab.kind)}
              data-testid={`file-template-tab-${tab.kind}`}
              className={`border-b-2 px-3 py-2 text-ui-body font-medium transition-colors ${
                activeKind === tab.kind
                  ? "border-ui-info-border text-[var(--taomni-code-text)]"
                  : "border-transparent text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Editor Body */}
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="file-template-editor-textarea"
              className="text-ui-small font-semibold text-[var(--taomni-code-muted)]"
            >
              Template Text ({activeKind}):
            </label>
            <textarea
              id="file-template-editor-textarea"
              value={templates[activeKind]}
              onChange={(e) =>
                setTemplates((prev) => ({
                  ...prev,
                  [activeKind]: e.target.value,
                }))
              }
              rows={10}
              data-testid="file-template-editor-textarea"
              className="w-full font-mono rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-input-bg,var(--taomni-code-bg))] p-2.5 text-ui-body text-[var(--taomni-code-text)] focus-visible:keyboard-outline focus:border-[var(--taomni-focus-ring)]"
            />
          </div>

          {/* Allowed Variables Info */}
          <div className="rounded bg-[var(--taomni-code-active-line-bg)]/40 p-2.5 text-ui-small">
            <div className="font-semibold text-[var(--taomni-code-muted)] mb-1">
              Available Variables:
            </div>
            <div className="flex flex-wrap gap-1.5 font-mono text-ui-caption">
              {ALLOWED_TEMPLATE_VARIABLES.map((v) => (
                <span
                  key={v}
                  className="rounded bg-[var(--taomni-code-border)]/60 px-1.5 py-0.5 text-[var(--taomni-code-text)]"
                >
                  ${"{" + v + "}"}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={handleReset}
            data-testid="file-template-reset-button"
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-ui-small text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset to Default</span>
          </button>

          <div className="flex items-center gap-2">
            {savedNotice && (
              <span className="text-ui-small text-ui-success font-medium">Saved!</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-ui-small text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              data-testid="file-template-save-button"
              data-primary="true"
              className="taomni-btn flex items-center gap-1.5 rounded px-3 py-1 font-medium text-ui-small"
            >
              <Save className="h-3.5 w-3.5" />
              <span>Save</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
