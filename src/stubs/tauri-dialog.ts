// Browser-preview stub for @tauri-apps/plugin-dialog. File pickers are
// desktop-only; in the browser preview these are no-ops.

export interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
}

export async function open(_options?: OpenDialogOptions): Promise<string | null> {
  return null;
}

export async function save(_options?: unknown): Promise<string | null> {
  return null;
}

export async function message(_message: string, _options?: unknown): Promise<void> {
  /* no-op in browser preview */
}
