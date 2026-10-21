import { useCallback, useRef, useState } from "react";
import { nextAnswerLanguage, readEditorAiPreferences, writeEditorAiPreferences } from "../editorAiPreferences";
import { type AiAnswerLanguage } from "../../../../lib/ai/answerLanguage";
import { readWorkspaceBookmarks, restoreWorkspaceBookmarksForFile, writeWorkspaceBookmarks, type WorkspaceBookmark } from "../todoBookmarks";


export interface UseWorkspacePreferencesContext {
  workspaceInstanceId: string;
}

export function useWorkspacePreferences(context: UseWorkspacePreferencesContext) {
  const { workspaceInstanceId } = context;
  const [editorAiPreferences, setEditorAiPreferences] = useState(
    () => readEditorAiPreferences(workspaceInstanceId),
  );
  // Read through a ref inside the context-menu builder so a language change
  // does not have to rebuild that callback.
  const editorAiPreferencesRef = useRef(editorAiPreferences);
  editorAiPreferencesRef.current = editorAiPreferences;
  const setAiAnswerLanguage = useCallback((answerLanguage: AiAnswerLanguage) => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  /** Keyboard/command path — steps through the options without opening a menu. */
  const cycleAiAnswerLanguage = useCallback(() => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage: nextAnswerLanguage(current.answerLanguage) };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  const [bookmarks, setBookmarks] = useState<WorkspaceBookmark[]>(
    () => readWorkspaceBookmarks(workspaceInstanceId),
  );
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const replaceBookmarks = useCallback((next: WorkspaceBookmark[]) => {
    bookmarksRef.current = next;
    setBookmarks(next);
  }, []);
  const restoreBookmarksForFileKey = useCallback((fileKeyValue: string, pathLabel?: string) => {
    const current = bookmarksRef.current;
    if (!current.some((bookmark) => bookmark.fileKey === fileKeyValue && bookmark.state === "missing")) return;
    const next = restoreWorkspaceBookmarksForFile(current, fileKeyValue, pathLabel);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);
  return { replaceBookmarks, bookmarksRef, restoreBookmarksForFileKey, editorAiPreferences, bookmarks, cycleAiAnswerLanguage, setAiAnswerLanguage, editorAiPreferencesRef };
}
