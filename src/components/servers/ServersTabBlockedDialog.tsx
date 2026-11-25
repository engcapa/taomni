import { useT } from "../../lib/i18n";
import { useServersStore } from "../../stores/serversStore";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

/** Another running Taomni instance owns the Local servers tab. */
export function ServersTabBlockedDialog() {
  const t = useT();
  const message = useServersStore((s) => s.tabBlockedMessage);
  const setTabBlockedMessage = useServersStore((s) => s.setTabBlockedMessage);
  if (!message) return null;

  const dismiss = () => setTabBlockedMessage(null);
  return (
    <Modal role="alertdialog" title={t("servers.tabAlreadyOpenTitle")} testId="servers-blocked-dialog"
      initialFocus='[data-testid="servers-blocked-ok"]' onCancel={dismiss}
      footer={<Button variant="primary" data-testid="servers-blocked-ok" onClick={dismiss}>{t("common.ok")}</Button>}>
      <p data-testid="servers-blocked-message">{message}</p>
    </Modal>
  );
}
