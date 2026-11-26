import { useT } from "../../../lib/i18n";
import { Modal } from "../../ui/Modal";
import type { LspShowMessageRequest } from "../../../lib/editor/lsp";

interface LspMessageRequestDialogProps {
  request: LspShowMessageRequest;
  onSelect: (actionIndex: number | null) => void;
}

/** Server-provided actions retain their order and their original indices. */
export function LspMessageRequestDialog({ request, onSelect }: LspMessageRequestDialogProps) {
  const t = useT();
  const initialFocus = request.actions.length ? "[data-lsp-message-first-action]" : "[data-lsp-message-cancel]";
  const title = request.messageType === 1 ? t("workspaceLsp.messageError")
    : request.messageType === 2 ? t("workspaceLsp.messageWarning") : t("workspaceLsp.messageTitle");
  return <Modal key={request.requestId} title={title} testId="lsp-message-request-dialog"
    closeLabel={t("workspaceLsp.dismissMessage")}
    initialFocus={initialFocus} tone={request.messageType === 1 ? "error" : undefined}
    onCancel={() => onSelect(null)} footer={<>
      <button type="button" data-lsp-message-cancel className="taomni-btn" onClick={() => onSelect(null)}>
        {t("common.cancel")}
      </button>
      {request.actions.map((action, index) => (
        <button key={index} type="button" data-lsp-message-first-action={index === 0 ? "" : undefined}
          className="taomni-btn max-w-full whitespace-normal break-words" data-primary={index === 0}
          onClick={() => onSelect(index)}>
          {action.title}
        </button>
      ))}
    </>}>
    <p className="font-semibold">{request.serverLabel}</p>
    <p data-testid="lsp-message-request-message" className="mt-2">{request.message}</p>
  </Modal>;
}
