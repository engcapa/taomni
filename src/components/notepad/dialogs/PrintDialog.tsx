import { NotepadDialog } from "./NotepadDialog";
import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { printNotepadDocument } from "../../../lib/notepad/print/printDocument";
import { setNotepadPreferences, useNotepadPreferences, type NotepadPrintColorMode } from "../../../stores/notepadPreferences";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function PrintDialog({
  open,
  title,
  content,
  selection,
  onClose,
}: {
  open: boolean;
  title: string;
  content: string;
  selection: string;
  onClose: () => void;
}) {
  const label = useViewerLabels();
  const prefs = useNotepadPreferences();
  const [opts, setOpts] = useState(prefs.printDefaults);

  useEffect(() => {
    if (!open) return;
    setOpts({
      ...prefs.printDefaults,
      range: prefs.printDefaults.range === "selection" && selection ? "selection" : "all",
    });
  }, [open, selection, prefs.printDefaults]);

  if (!open) return null;

  return (
    <NotepadDialog testId="notepad-print-dialog" onClose={onClose}
      title={<span className="inline-flex items-center gap-1.5"><Printer size={14} />{label("打印选项", "Print Setup")}</span>}
      footer={<>
        <button type="button" className="np-btn" onClick={onClose}>{label("取消", "Cancel")}</button>
        <button
          type="button"
          className="np-btn primary"
          data-testid="notepad-print-confirm"
          onClick={() => {
            setNotepadPreferences({ printDefaults: opts });
            printNotepadDocument({
              title,
              content,
              selection,
              settings: opts,
              fontSizePx: prefs.fontSize,
            });
            onClose();
          }}
        >
          {label("打印", "Print")}
        </button>
      </>}>
      <div className="grid grid-cols-2 gap-2 text-ui-body">
        <label className="flex flex-col gap-1">
          <span>{label("打印范围", "Range")}</span>
          <select
            className="np-input"
            value={opts.range}
            onChange={(e) => setOpts({ ...opts, range: e.target.value as "all" | "selection" })}
          >
            <option value="all">{label("全部内容", "Entire Document")}</option>
            <option value="selection" disabled={!selection}>{label("仅选中文本", "Selection Only")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{label("色彩模式", "Color Mode")}</span>
          <select
            className="np-input"
            value={opts.colorMode}
            onChange={(e) => setOpts({ ...opts, colorMode: e.target.value as NotepadPrintColorMode })}
          >
            <option value="wysiwyg">WYSIWYG</option>
            <option value="bw">{label("纯黑打印", "Black on White")}</option>
            <option value="inv">{label("反色", "Invert")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{label("页眉模板", "Header")}</span>
          <input type="text" className="np-input" value={opts.header} onChange={(e) => setOpts({ ...opts, header: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{label("页脚模板", "Footer")}</span>
          <input type="text" className="np-input" value={opts.footer} onChange={(e) => setOpts({ ...opts, footer: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{label("页边距 (mm)", "Margins (mm)")}</span>
          <input type="number" min={0} max={50} className="np-input" value={opts.marginMm} onChange={(e) => setOpts({ ...opts, marginMm: Number(e.target.value) })} />
        </label>
        <label className="inline-flex items-center gap-2 self-end pb-1">
          <input type="checkbox" checked={opts.lineNumbers} onChange={(e) => setOpts({ ...opts, lineNumbers: e.target.checked })} />
          {label("打印行号", "Print Line Numbers")}
        </label>
      </div>
    </NotepadDialog>
  );
}
