import { AlertTriangle } from "lucide-react";
import { Button } from "../../../../../src/components/ui/Button";
import { Modal } from "../../../../../src/components/ui/Modal";
import { useT } from "../../../../../src/lib/i18n";
import type { ComposePromptState } from "./types";

export function MailComposePrompt({ prompt, onClose, onAttach, onSendAnyway }: {
  prompt: ComposePromptState;
  onClose: () => void;
  onAttach: () => void;
  onSendAnyway: () => void;
}) {
  const t = useT();
  const attachment = prompt.kind === "attachment";
  const first = attachment ? "mail-attach-reminder-cancel" : "mail-compose-error-ok";
  return <Modal
    testId={attachment ? "mail-attach-reminder" : "mail-compose-error-dialog"}
    role={attachment ? "dialog" : "alertdialog"}
    title={t(attachment ? "mailCompose.attachmentMissing" : "mailCompose.cannotSend")}
    tone={attachment ? "default" : "error"}
    initialFocus={`[data-testid="${first}"]`}
    onCancel={onClose}
    footer={attachment ? <>
      <Button data-testid="mail-attach-reminder-cancel" onClick={onClose}>{t("common.cancel")}</Button>
      <Button data-testid="mail-attach-reminder-send" onClick={onSendAnyway}>{t("mailCompose.sendAnyway")}</Button>
      <Button variant="primary" data-testid="mail-attach-reminder-attach" onClick={onAttach}>{t("mailCompose.attach")}</Button>
    </> : <Button variant="primary" data-testid="mail-compose-error-ok" onClick={onClose}>{t("common.ok")}</Button>}
  >
    <div className="flex items-start gap-2">
      <AlertTriangle aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${attachment ? "text-ui-warning" : "text-ui-danger"}`} />
      <p data-testid="mail-compose-prompt-message">{attachment ? t("mailCompose.attachmentReminder") : prompt.message}</p>
    </div>
  </Modal>;
}
