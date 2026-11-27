import { ExternalLink } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useViewerLabels } from "./viewerLabels";

/** Only a decision in the parent window grants OS navigation. */
export function HtmlPreviewExternalLinkDialog({ href, onDecision }: {
  href: string; onDecision: (open: boolean) => void;
}) {
  const label = useViewerLabels();
  const cancel = () => onDecision(false);
  return (
    <Modal title={label("在系统浏览器中打开外部链接？", "Open this external link in your system browser?")}
      testId="html-external-dialog" initialFocus='[data-testid="html-external-cancel"]' onCancel={cancel}
      footer={<>
        <Button data-testid="html-external-cancel" onClick={cancel}>{label("取消", "Cancel")}</Button>
        <Button variant="primary" data-testid="html-external-open" onClick={() => onDecision(true)}>
          <ExternalLink aria-hidden="true" className="mr-1 size-4" />{label("在浏览器中打开", "Open in browser")}
        </Button>
      </>}>
      <p>{label("此请求来自本地预览页面，页面脚本也可能发起此请求。请确认目标地址。", "This request came from the local preview page and may have been initiated by a page script. Check the destination before opening.")}</p>
      <p className="my-2"><strong>{label("目标站点", "Destination origin")}</strong><br />
        <bdi data-testid="html-external-origin" dir="ltr">{new URL(href).origin}</bdi>
      </p>
      <p data-testid="html-external-url" dir="ltr">{href}</p>
    </Modal>
  );
}
