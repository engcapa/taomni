/**
 * Per-session reference counts. Each component that calls `attach` for a
 * session id holds one reference until it calls `detach`. The backend
 * channel + zustand entry are torn down only when the count reaches zero.
 *
 * This guards against React StrictMode double-invocation (mount → cleanup
 * → mount) where the cleanup detach would otherwise yank the channel out
 * from under the immediately-following remount attach. It also lets two
 * legitimate consumers — e.g. an attached sidebar and a detached window
 * that happen to share an `attached-${tabId}` session id — coexist
 * without one tearing down the other.
 */
export const sessionRefCounts = new Map<string, number>();

/**
 * In-flight backend attach promises, keyed by session id. When a second
 * consumer calls attach before the first one finishes the backend handshake,
 * we await the same promise instead of issuing a duplicate `sftpAttach`
 * IPC call. Keeps the backend channel count at exactly one per session id
 * regardless of how many UI consumers race to mount.
 */
export const inFlightAttaches = new Map<string, Promise<void>>();
