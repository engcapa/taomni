

export type InvokeArgs = Record<string, unknown>;

export interface InvokeOptions {
  headers?: Record<string, string>;
}

export let nextBrowserChannelId = 0;

export class Channel<T = unknown> {
  id = nextBrowserChannelId++;
  onmessage: ((message: T) => void) | null = null;
}

// Base class mirrored from `@tauri-apps/api/core`. Plugins like
// `@tauri-apps/plugin-updater` (Update extends Resource) import it, so the
// browser build needs the symbol to exist. It's never exercised here — update
// flows are guarded by isTauriRuntime() and no-op outside the desktop app.
export class Resource {
  readonly rid: number;
  constructor(rid: number) {
    this.rid = rid;
  }
  async close(): Promise<void> {
    /* no-op in browser preview */
  }
}

/** No-op plugin-listener shim so plugins that import `addPluginListener`
 *  (e.g. @tauri-apps/plugin-notification) load in browser preview. */
export class PluginListener {
  constructor(
    public plugin: string,
    public event: string,
    public channelId: number,
  ) {}
  async unregister(): Promise<void> {
    /* no-op in browser preview */
  }
}

export async function addPluginListener(
  plugin: string,
  event: string,
  _cb: (payload: unknown) => void,
): Promise<PluginListener> {
  return new PluginListener(plugin, event, 0);
}

export function convertFileSrc(path: string): string {
  return path;
}
