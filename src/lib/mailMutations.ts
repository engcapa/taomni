import type { MailMutationProgress } from "./mail";

export class MailMutationError extends Error {
  constructor(message: string, readonly detail: string | null, readonly retryable: boolean) {
    super(message);
  }
}

/** One user action, retained while Retry continues its unfinished requests. */
export class MailMutationSession {
  private requests = new Map<string, { id: string; done: Set<number>; complete: boolean }>();
  total = 0;
  completed = 0;
  get used() { return this.requests.size > 0; }

  async execute(
    key: string,
    uids: number[],
    invoke: (operationId: string) => Promise<{ mutation?: MailMutationProgress | null } | undefined>,
    apply: (completed: number[]) => void,
    progress: (completed: number, total: number) => void,
  ): Promise<number> {
    let request = this.requests.get(key);
    if (!request) {
      request = { id: crypto.randomUUID(), done: new Set(), complete: false };
      this.requests.set(key, request);
    }
    if (request.complete) return request.done.size;
    const result = await invoke(request.id);
    const receipt = result?.mutation;
    if (receipt) request.id = receipt.operationId;
    const allowed = new Set(uids);
    const done = (receipt?.completedUids ?? uids).filter((uid) =>
      (uids.length === 0 || allowed.has(uid)) && !request.done.has(uid));
    for (const uid of done) request.done.add(uid);
    this.completed += done.length;
    if (this.total === 0 && receipt) this.total = receipt.completedUids.length + receipt.pendingUids.length;
    if (done.length) apply(done);
    progress(this.completed, this.total);
    if (receipt?.error) {
      throw new MailMutationError(
        `Processed ${this.completed}/${this.total} messages. ${receipt.error}`,
        receipt.detail ?? null, receipt.retryable,
      );
    }
    request.complete = true;
    return request.done.size;
  }
}
