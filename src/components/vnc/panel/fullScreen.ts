import { getCurrentWindow } from "@tauri-apps/api/window";


/** Keysyms for keys the Windows keyboard hook passes through (VNC-INPUT-003). */
/** Window state screen-level full screen changed, restored on exit. */
export type FullScreenRestore = { maximized: boolean; osFullscreen: boolean; resizable: boolean; };


export async function restoreWindowAfterFullScreen(
  w: ReturnType<typeof getCurrentWindow>,
  restore: FullScreenRestore | null,
): Promise<void> {
  if (!restore?.osFullscreen) await w.setFullscreen(false);
  if (restore?.resizable) await w.setResizable(true);
  if (restore?.maximized) await w.maximize();
}
