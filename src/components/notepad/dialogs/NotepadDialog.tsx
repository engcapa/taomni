import { useId, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { ModalSurface } from "../../ui/ModalSurface";

interface NotepadDialogProps {
  testId: string;
  title: ReactNode;
  onClose: () => void;
  closeId?: string;
  initialFocus?: string;
  wide?: boolean;
  style?: CSSProperties;
  children: ReactNode;
  footer?: ReactNode;
}

export function NotepadDialog({ testId, title, onClose, closeId, initialFocus = ".np-modal-header button",
  wide, style, children, footer }: NotepadDialogProps) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const close = t("common.close");
  return <ModalSurface data-testid={testId} className={wide ? "np-modal wide" : "np-modal"} style={style}
    initialFocus={initialFocus} onCancel={onClose} aria-labelledby={titleId} aria-describedby={bodyId}>
    <header className="np-modal-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="np-btn" onClick={onClose} data-testid={closeId ?? testId + "-close"}
        aria-label={close} data-taomni-tooltip={close}><X size={14} aria-hidden="true" /></button>
    </header>
    <div className="np-modal-body" id={bodyId}>{children}</div>
    {footer && <footer className="taomni-modal-footer">{footer}</footer>}
  </ModalSurface>;
}
