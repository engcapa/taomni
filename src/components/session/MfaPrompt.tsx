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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <form
        data-testid="mfa-prompt"
        onSubmit={handleSubmit}
        className="w-[420px] rounded-md shadow-2xl border overflow-hidden"
        style={{
          background: "var(--moba-panel-bg)",
          borderColor: "var(--moba-chrome-border)",
          color: "var(--moba-text)",
        }}
      >
        <div
          className="h-8 flex items-center px-3"
          style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}
        >
          <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-[12px] font-semibold">
            {request.name?.trim() ? request.name : t("mfaPrompt.title")}
          </span>
          <div className="flex-1" />
          <button
            data-testid="mfa-close"
            type="button"
            onClick={onCancel}
            aria-label={t("mfaPrompt.closeAria")}
            className="hover:bg-white/20 rounded p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4">
          <div className="text-[12px] mb-2 text-[var(--moba-text-muted)]">
            {t("mfaPrompt.subtitle", { user: username, host })}
          </div>
          {request.instructions?.trim() && (
            <div
              data-testid="mfa-instructions"
              className="text-[12px] mb-3 whitespace-pre-wrap"
              style={{ color: "var(--moba-text)" }}
            >
              {request.instructions}
            </div>
          )}

          {request.prompts.map((p, idx) => (
            <div key={idx} className={idx > 0 ? "mt-3" : undefined}>
              <label className="block text-[12px] mb-1" style={{ color: "var(--moba-text)" }}>
                {p.prompt?.trim() ? p.prompt : t("mfaPrompt.defaultPrompt")}
              </label>
              <input
                data-testid={`mfa-answer-${idx}`}
                aria-label={t("mfaPrompt.answerAria")}
                type={p.echo ? "text" : "password"}
                autoFocus={idx === 0}
                value={answers[idx] ?? ""}
                onChange={(e) => setAnswer(idx, e.target.value)}
                className="moba-input w-full h-8 text-[13px]"
                autoComplete="one-time-code"
              />
            </div>
          ))}
        </div>

        <div
          className="h-12 flex items-center justify-end px-3 gap-2 border-t"
          style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
        >
          <button data-testid="mfa-cancel" type="button" onClick={onCancel} className="moba-btn">
            {t("mfaPrompt.cancel")}
          </button>
          <button
            type="submit"
            data-testid="mfa-submit"
            className="moba-btn font-semibold"
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
