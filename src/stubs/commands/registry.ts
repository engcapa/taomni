import type { InvokeOptions } from "./runtime";
export type StubCommandHandler<T = unknown> = (args: Record<string, unknown> | undefined, options?: InvokeOptions) => T | Promise<T>;

export type StubCommandDomain = string;

export interface StubCommandRegistration {
  domain: StubCommandDomain;
  command: string;
  handler: StubCommandHandler;
}

/** Registry for focused browser fixtures and test overrides. */
export class CommandRegistry {
  private readonly handlers = new Map<string, StubCommandRegistration>();

  register(registration: StubCommandRegistration): () => void {
    if (this.handlers.has(registration.command)) {
      throw new Error(`Stub command already registered: ${registration.command}`);
    }
    const entry = { ...registration };
    this.handlers.set(entry.command, entry);
    return () => {
      if (this.handlers.get(entry.command) === entry) this.handlers.delete(entry.command);
    };
  }

  registerMany(registrations: readonly StubCommandRegistration[]): () => void {
    const names = new Set(this.handlers.keys());
    for (const registration of registrations) {
      if (names.has(registration.command)) {
        throw new Error(`Stub command already registered: ${registration.command}`);
      }
      names.add(registration.command);
    }
    const cleanups = registrations.map((registration) => this.register(registration));
    return () => cleanups.forEach((cleanup) => cleanup());
  }

  has(command: string): boolean {
    return this.handlers.has(command);
  }

  async invoke<T>(command: string, args?: Record<string, unknown>, options?: InvokeOptions): Promise<T> {
    const registration = this.handlers.get(command);
    if (!registration) throw new Error(`Stub command is not registered: ${command}`);
    return (await registration.handler(args, options)) as T;
  }

  list(): StubCommandRegistration[] {
    return [...this.handlers.values()].map((registration) => ({ ...registration }));
  }

  clear(): void {
    this.handlers.clear();
  }
}
