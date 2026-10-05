import { invoke } from "@tauri-apps/api/core";

/** SQLite is authoritative on desktop; WebView localStorage remains the browser
 * store and the one-time migration source for existing desktop profiles. */
export class NativeLayoutPersistence {
  private stored: string | null | undefined;
  private loading: Promise<string | null> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private read = () => invoke<string | null>("load_shell_layout"),
    private write = (layout: string, expectedLayout: string | null) =>
      invoke<void>("save_shell_layout", { layout, expectedLayout }),
  ) {}

  load(): Promise<string | null> {
    if (this.stored !== undefined) return Promise.resolve(this.stored);
    if (!this.loading) {
      this.loading = this.read().then((value) => { this.stored = value; return value; })
        .finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }

  save(layout: string, reset = false): Promise<void> {
    // A later save may retry an I/O failure, but must never bypass the comparison
    // with the last acknowledged record. Only the explicit Reset rereads it.
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (reset) this.stored = await this.read();
      const expected = await this.load();
      if (layout === expected) return;
      await this.write(layout, expected);
      this.stored = layout;
    });
    return this.writes;
  }

  settled(): Promise<void> { return this.writes; }
}
