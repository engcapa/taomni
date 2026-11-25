import { X } from "lucide-react";
import { NotepadSettingsPanel } from "../../settings/NotepadSettingsPanel";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function PreferencesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const label = useViewerLabels();
  if (!open) return null;

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-preferences-dialog">
      <div className="np-modal wide">
        <div className="np-modal-header">
          <span>{label("Notepad 首选项", "Notepad Preferences")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>
        <NotepadSettingsPanel />
        <div className="flex justify-end">
          <button type="button" className="np-btn primary" onClick={onClose}>{label("完成", "Done")}</button>
        </div>
      </div>
    </div>
  );
}
