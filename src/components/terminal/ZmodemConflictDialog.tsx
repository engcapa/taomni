import { useState } from "react";
import type { ConflictAction, ConflictActionType } from "../../lib/zmodem";
import { useT } from "../../lib/i18n";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export interface ZmodemConflictDialogProps {
  fileName: string;
  hasMore: boolean;
  mode: "receive" | "send";
  onResolve: (action: ConflictAction) => void;
}

export function ZmodemConflictDialog({ fileName, hasMore, mode, onResolve }: ZmodemConflictDialogProps) {
  const [applyToAll, setApplyToAll] = useState(false);
  const t = useT();
  const resolve = (type: ConflictActionType) => onResolve({ type, applyToAll: hasMore && applyToAll });
  const title = t(mode === "send" ? "terminal.zmodemConflictTitleSend" : "terminal.zmodemConflictTitleReceive");
  return (
    <Modal title={title} testId="zmodem-conflict" initialFocus='[data-testid="zmodem-skip"]'
      onCancel={() => resolve("skip")} footer={<>
        <Button data-testid="zmodem-skip" onClick={() => resolve("skip")}>{t("terminal.zmodemSkip")}</Button>
        <Button data-testid="zmodem-rename" onClick={() => resolve("rename")}>{t("terminal.zmodemRename")}</Button>
        {mode === "receive" && (
          <Button variant="danger" data-testid="zmodem-overwrite" onClick={() => resolve("overwrite")}>
            {t("terminal.zmodemOverwrite")}
          </Button>
        )}
      </>}>
      <p dir="auto">{fileName}</p>
      {hasMore && (
        <label className="mt-2 flex min-h-6 items-center gap-2 text-ui-body">
          <input type="checkbox" className="taomni-checkbox" checked={applyToAll}
            onChange={(event) => setApplyToAll(event.target.checked)} />
          {t("terminal.zmodemApplyToAll")}
        </label>
      )}
    </Modal>
  );
}
