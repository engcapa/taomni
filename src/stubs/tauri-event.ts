export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  payload: T;
  id: number;
  windowLabel: string;
}

export type EventCallback<T> = (event: Event<T>) => void;

const listeners: Map<string, Set<EventCallback<unknown>>> = new Map();

export async function listen<T>(
  event: string,
  callback: EventCallback<T>,
): Promise<UnlistenFn> {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(callback as EventCallback<unknown>);
  return () => {
    listeners.get(event)?.delete(callback as EventCallback<unknown>);
  };
}

export async function once<T>(
  event: string,
  callback: EventCallback<T>,
): Promise<UnlistenFn> {
  let unlisten: UnlistenFn;
  const wrapper: EventCallback<T> = (e) => {
    callback(e);
    unlisten();
  };
  unlisten = await listen(event, wrapper);
  return unlisten;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  const handlers = listeners.get(event);
  if (!handlers) return;
  const e = { event, payload, id: 0, windowLabel: "main" } as Event<unknown>;
  for (const cb of handlers) {
    cb(e);
  }
}
