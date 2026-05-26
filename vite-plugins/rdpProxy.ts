/**
 * Stub Vite plugin for RDP in browser dev mode.
 *
 * RDP is a desktop-only protocol — in browser mode the user gets a clear
 * error telling them to run the Tauri app instead of trying to connect.
 * The plugin only exists so `pnpm dev` doesn't crash when `src/lib/rdp.ts`
 * imports `@tauri-apps/api/core` (the stub forwarder lives in `src/stubs/`).
 */
import type { Plugin } from "vite";

export const RDP_BRIDGE_PATH = "/__newmob/rdp-bridge";

export function rdpProxyPlugin(): Plugin {
  return {
    name: "newmob-rdp-proxy",
    configureServer(server) {
      server.middlewares.use(RDP_BRIDGE_PATH, (_req, res) => {
        res.statusCode = 501;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          "RDP is desktop-only. Run `pnpm tauri dev` for the full client.",
        );
      });
    },
  };
}

export default rdpProxyPlugin;
