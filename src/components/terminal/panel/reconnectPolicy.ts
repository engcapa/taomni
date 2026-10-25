/** One cancellable retry owner per terminal lifetime. Failed initial logins do
 * not retry automatically; only a previously established connection may retry. */
export function createReconnectPolicy(enabled: boolean, reconnect: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let connected = false;
  let disposed = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  return {
    connected() { cancel(); connected = true; attempts = 0; },
    started() { cancel(); },
    disconnected() {
      if (!enabled || !connected || disposed || timer !== undefined || attempts >= 5) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) reconnect();
      }, delay);
    },
    dispose() { disposed = true; cancel(); },
  };
}
