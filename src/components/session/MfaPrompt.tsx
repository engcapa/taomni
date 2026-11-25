import { useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import type { SshAuthPromptPayload } from "../../lib/ipc";
import { useT } from "../../lib/i18n";

interface MfaPromptProps {
  host: string;
  username: string;
  request: SshAuthPromptPayload;
  /** Answers in the same order as `request.prompts`. */
  onSubmit: (responses: string[]) => void;
  onCancel: () => void;
}

/**
 * Modal for keyboard-interactive SSH auth (MFA/OTP). Renders one input per
 * server prompt, masking the field when the server marks it non-echo (the
 * common case for OTP codes and passwords). Used when a host such as an Aliyun
 * bastion demands a second factor mid-connect.
 */
export function MfaPrompt({ host, username, request, onSubmit, onCancel }: MfaPromptProps) {
  const t = useT();
  const [answers, setAnswers] = useState<string[]>(() => request.prompts.map(() => ""));

  const setAnswer = (idx: number, value: string) =>
    setAnswers((prev) => {
      const next = prev.slice();
      next[idx] = value;
      return next;
    });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(answers);
  };

  return (
    <div
      className="fixed inset-0 taomni-dialog-backdrop flex items-center justify-center"
    >
      <form
        data-testid="mfa-prompt"
        onSubmit={handleSubmit}
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-md shadow-2xl border overflow-hidden"
        style={{
          background: "var(--taomni-panel-bg)",
          borderColor: "var(--taomni-chrome-border)",
          color: "var(--taomni-text)",
        }}
      >
        <div
          className="h-8 flex shrink-0 items-center px-3"
          style={{ background: "var(--taomni-chrome-bg)", color: "var(--taomni-text)" }}
        >
          <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-ui-body font-semibold">
            {request.name?.trim() ? request.name : t("mfaPrompt.title")}
          </span>
          <div className="flex-1" />
          <button
            data-testid="mfa-close"
            type="button"
            onClick={onCancel}
            aria-label={t("mfaPrompt.closeAria")}
            className="hover:bg-[var(--taomni-control-hover)] rounded p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="text-ui-body mb-2 text-[var(--taomni-text-muted)]">
            {t("mfaPrompt.subtitle", { user: username, host })}
          </div>
          {request.instructions?.trim() && (
            <div
              data-testid="mfa-instructions"
              className="text-ui-body mb-3 whitespace-pre-wrap"
              style={{ color: "var(--taomni-text)" }}
            >
              {request.instructions}
            </div>
          )}

          {request.prompts.map((p, idx) => (
            <div key={idx} className={idx > 0 ? "mt-3" : undefined}>
              <label className="block text-ui-body mb-1" style={{ color: "var(--taomni-text)" }}>
                {p.prompt?.trim() ? p.prompt : t("mfaPrompt.defaultPrompt")}
              </label>
              <input
                data-testid={`mfa-answer-${idx}`}
                aria-label={t("mfaPrompt.answerAria")}
                type={p.echo ? "text" : "password"}
                autoFocus={idx === 0}
                value={answers[idx] ?? ""}
                onChange={(e) => setAnswer(idx, e.target.value)}
                className="taomni-input w-full h-8 text-ui-body"
                autoComplete="one-time-code"
              />
            </div>
          ))}
        </div>

        <div
          className="min-h-12 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <button data-testid="mfa-cancel" type="button" onClick={onCancel} className="taomni-btn">
            {t("mfaPrompt.cancel")}
          </button>
          <button
            type="submit"
            data-testid="mfa-submit"
            className="taomni-btn font-semibold"
            data-primary="true"
          >
            {t("mfaPrompt.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

export default MfaPrompt;
