import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { Modal } from "../../ui/Modal";
import type { CellValueViewer } from "./types";

export function CellValueDialog({ viewer, returnFocus, onCopy, onClose }: {
  viewer: CellValueViewer;
  returnFocus: HTMLElement | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [wrap, setWrap] = useState(true);
  const t = useT();
  const title = t("dbCellValue.title", { column: viewer.column.name });

  return <Modal title={title} testId="query-cell-value-dialog" size="wide"
    initialFocus='[data-testid="query-cell-value-text"]' returnFocus={returnFocus}
    onCancel={onClose} dismissOnBackdrop
    footer={<>
      <label className="mr-auto inline-flex items-center gap-2">
        <input type="checkbox" data-testid="query-cell-value-wrap" checked={wrap}
          onChange={(event) => setWrap(event.target.checked)} />
        {t("dbCellValue.wrap")}
      </label>
      <button type="button" className="taomni-btn" data-testid="query-cell-value-copy" onClick={onCopy}>
        {t("common.copy")}
      </button>
      <button type="button" className="taomni-btn" onClick={onClose}>{t("common.close")}</button>
    </>}>
    <p className="mb-2 text-ui-small text-theme-muted">
      {t("dbCellValue.details", {
        row: viewer.rowNumber,
        type: viewer.column.type,
        chars: viewer.value?.length ?? 0,
        lines: viewer.value == null ? 0 : viewer.value.split(/\r\n|\r|\n/).length,
      })}
    </p>
    <textarea data-testid="query-cell-value-text" aria-label={title}
      className="taomni-input block w-full resize-none font-mono text-ui-body"
      style={{ height: "min(40vh, 360px)", whiteSpace: wrap ? "pre-wrap" : "pre" }}
      wrap={wrap ? "soft" : "off"} readOnly value={viewer.value ?? "NULL"} />
  </Modal>;
}
