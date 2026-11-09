import { useNotesContentStore } from "../../stores/notesContentStore";
import { confirmAppDialog } from "../../lib/appDialogs";
import { writeText } from "../../lib/clipboard";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";

export function NoteContentStatus({ noteId }: { noteId: string }) {
  const t = useT();
  const doc = useNotesContentStore((state) => state.documents[noteId]);
  const recoveryError = useNotesContentStore((state) => state.recoveryError);
  if (!doc?.error && !recoveryError) return null;
  return <div role="alert" data-testid="note-content-error" data-error-kind={doc?.error ?? "recovery"}
    className="shrink-0 border-b border-[var(--taomni-divider)] p-2 text-xs text-[var(--taomni-danger)]">
    <p>{recoveryError ? t("notes.draftRecoveryFailed") : t(`notes.contentError_${doc!.error}`)}</p>
    {doc?.errorDetail && <p className="break-words">{doc.errorDetail}</p>}
    <div className="mt-1 flex gap-2">
      {doc?.error === "storage" && <button type="button" className="taomni-btn px-2" data-testid="note-content-retry"
        onClick={() => { void useNotesContentStore.getState().save(noteId); }}>{t("notes.retrySave")}</button>}
      {doc?.error && doc.error !== "missing" && <button type="button" className="taomni-btn px-2" data-testid="note-content-reload"
        onClick={() => {
          void (async () => {
            const current = useNotesContentStore.getState().documents[noteId];
            if (current?.dirty && !await confirmAppDialog({ message: t("notes.reloadConfirm"), confirmLabel: t("notes.reloadContent"), danger: true })) return;
            await useNotesContentStore.getState().reload(noteId);
          })();
        }}>{t("notes.reloadContent")}</button>}
      {doc?.dirty && <button type="button" className="taomni-btn px-2" data-testid="note-content-copy"
        onClick={() => {
          const current = useNotesContentStore.getState().documents[noteId];
          void writeText(`${current.title}\n\n${current.body}`).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
        }}>{t("notes.copyDraft")}</button>}
    </div>
  </div>;
}
