import type { CodeWorkspaceFileRef } from "../../../types";

/** View-model for an open buffer as seen by EditorGroup (presentation only). */
export interface OpenFileViewModel {
  ref: CodeWorkspaceFileRef;
  key: string;
  path: string;
  title: string;
  subtitle: string;
  languagePath: string;
  text: string;
  savedText: string;
  hash: string;
  mtime: number;
  size: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}
