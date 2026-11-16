import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createPortal, flushSync } from "react-dom";
import { create, createStore, useStore } from "zustand";
import { Check, Loader2, Package, RefreshCw, X } from "lucide-react";
import { getLocale, t, useLocale, useT } from "./i18n";
import { cancelPluginRequest, invokePlugin } from "./ipc/plugin";
import { PLUGIN_CORE_API_VERSION } from "./pluginRegistry";

export interface PluginFrontendApi {
  invoke: <T = unknown>(command: string, payload?: unknown, options?: { signal?: AbortSignal }) => Promise<T>;
  dispose: () => void;
}

export interface PluginFrontendProps {
  tabId: string;
  kind: string;
  active: boolean;
  api: PluginFrontendApi;
}

/** Each mounted tab owns cancellation; callbacks from an old activation fail closed. */
export function createPluginFrontendApi(slug: string, isCurrent: () => boolean): PluginFrontendApi {
  const requests = new Map<string, () => void>();
  let disposed = false;
  const cancel = (id: string) => { void cancelPluginRequest(slug, id).catch(() => undefined); };
  return {
    invoke: async <T,>(command: string, payload?: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
      const signal = options?.signal;
      if (disposed || !isCurrent() || signal?.aborted) throw new DOMException("Module request cancelled", "AbortError");
      const id = crypto.randomUUID();
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => { cancel(id); reject(new DOMException("Module request cancelled", "AbortError")); };
      });
      requests.set(id, abort);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await Promise.race([invokePlugin<T>(slug, command, payload, { requestId: id }), cancelled]);
        if (disposed || !isCurrent()) throw new DOMException("Module activation changed", "AbortError");
        return result;
      } finally {
        requests.delete(id);
        signal?.removeEventListener("abort", abort);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const abort of requests.values()) abort();
      requests.clear();
    },
  };
}

const host = Object.freeze({
  coreApiVersion: PLUGIN_CORE_API_VERSION,
  React,
  jsxRuntime,
  ReactDOM: Object.freeze({ createPortal, flushSync }),
  zustand: Object.freeze({ create, createStore, useStore }),
  icons: Object.freeze({ Check, Loader2, Package, RefreshCw, X }),
  i18n: Object.freeze({ getLocale, t, useLocale, useT }),
});

export type PluginFrontendHost = typeof host;

declare global {
  var __taomniHost: PluginFrontendHost | undefined;
}

/** Called in every plugin WebView before evaluating any signed ESM. */
export function installPluginFrontendHost(): PluginFrontendHost {
  if (globalThis.__taomniHost) {
    if (globalThis.__taomniHost.coreApiVersion !== host.coreApiVersion || globalThis.__taomniHost.React !== React) {
      throw new Error("Conflicting module frontend host");
    }
    return globalThis.__taomniHost;
  }
  if (!globalThis.__taomniHost) {
    Object.defineProperty(globalThis, "__taomniHost", { value: host, configurable: false, writable: false });
  }
  return host;
}
