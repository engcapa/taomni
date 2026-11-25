import { getHomeDir } from "../../../lib/ipc/files";
import { defaultNotepadSavePath, notepadSaveDirectory } from "../../../lib/notepad/persistence/savePath";
import { isUntitledKey } from "../../../lib/openFile/pathIdentity";
import { getAppPlatform } from "../../../lib/runtime";
import { parentPath } from "../../../lib/sftp";
import { useNotepadPreferences } from "../../../stores/notepadPreferences";

export interface NotepadSaveAsDefaults {
  defaultPath: string;
  initialPath: string;
  defaultDir: string;
}

/**
 * Defaults for the Notepad Save As / Save a Copy dialog (U2).
 *
 * A document that already lives on disk keeps its current path prefilled so the
 * user edits a copy in place. An untitled document gets the absolute
 * `<lastSaveDir or $HOME>/<title>.txt`; the browse picker opens in the same
 * directory (`defaultDir`), which is also remembered after a successful save.
 */
export async function resolveNotepadSaveAsDefaults(
  currentPath: string,
  titleHint: string,
): Promise<NotepadSaveAsDefaults> {
  if (currentPath && !isUntitledKey(currentPath)) {
    return {
      defaultPath: currentPath,
      initialPath: currentPath,
      defaultDir: parentPath(currentPath),
    };
  }
  const home = await getHomeDir().catch(() => null);
  const directory = notepadSaveDirectory(useNotepadPreferences.getState().lastSaveDir, home);
  const defaultPath = defaultNotepadSavePath(
    directory,
    `${titleHint || "untitled"}.txt`,
    getAppPlatform(),
  );
  return { defaultPath, initialPath: defaultPath, defaultDir: directory };
}
