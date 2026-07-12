import type { CodeWorkspaceFileRef } from "../../../types";

/** On-disk line ending style preserved across the LF-normalized editor buffer. */
export type OpenFileEol = "LF" | "CRLF" | "CR";

/** View-model for an open buffer as seen by EditorGroup (presentation only). */
export interface OpenFileViewModel {
  ref: CodeWorkspaceFileRef;
  key: string;
  path: string;
  title: string;
  subtitle: string;
  languagePath: string;
  /** Buffer text with LF line endings (CodeMirror-normalized). */
  text: string;
  /** Last saved buffer text (also LF-normalized). */
  savedText: string;
  /** Original on-disk line ending style; applied on write. */
  eol: OpenFileEol;
  hash: string;
  mtime: number;
  size: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}
