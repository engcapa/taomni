import appIcon from "../../src-tauri/icons/128x128.png";
import { useT } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  const t = useT();
  const check = useUpdateStore((state) => state.check);
  const handleCheckUpdate = () => {
    onClose();
    void check({ manual: true });
  };

  return (
    <Modal title={t("about.title")} testId="about-dialog" initialFocus='[data-testid="about-close"]'
      dismissOnBackdrop onCancel={onClose}
      footer={<>
        <Button onClick={handleCheckUpdate} data-testid="about-check-update">{t("update.checkButton")}</Button>
        <Button onClick={onClose} data-testid="about-close">{t("common.close")}</Button>
      </>}>
      <div className="mb-3 flex items-center gap-3">
        <img src={appIcon} alt="" className="size-12 shrink-0" />
        <div>
          <div className="text-ui-title font-semibold">{t("app.name")}</div>
          <Button variant="link" className="taomni-mono" data-testid="about-version"
            title={t("about.versionTooltip")} onClick={handleCheckUpdate}>
            {t("about.version", { version: __APP_VERSION__ })}
          </Button>
        </div>
      </div>
      <p className="text-ui-body text-[var(--taomni-text-muted)]">{t("about.description")}</p>
    </Modal>
  );
}
