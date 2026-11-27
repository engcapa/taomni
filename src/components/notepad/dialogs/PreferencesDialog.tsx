import { NotepadDialog } from "./NotepadDialog";
import { NotepadSettingsPanel } from "../../settings/NotepadSettingsPanel";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function PreferencesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const label = useViewerLabels();
  if (!open) return null;

  return (
    <NotepadDialog testId="notepad-preferences-dialog" onClose={onClose} wide
      title={label("Notepad 首选项", "Notepad Preferences")}
      footer={<>
        <button type="button" className="np-btn primary" onClick={onClose}>{label("完成", "Done")}</button>
      </>}>
      <NotepadSettingsPanel />
    </NotepadDialog>
  );
}
