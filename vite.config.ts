import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";
import { sshProxyPlugin } from "./vite-plugins/sshProxy";
import { sftpProxyPlugin } from "./vite-plugins/sftpProxy";
import { rdpProxyPlugin } from "./vite-plugins/rdpProxy";

const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

const devPort = isTauriBuild ? 1980 : 5000;

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as {
  version: string;
};

export default defineConfig({
  plugins: [tailwindcss(), react(), ...(isTauriBuild ? [] : [sshProxyPlugin(), sftpProxyPlugin(), rdpProxyPlugin()])],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    include: ["zmodem.js"],
    // In browser preview the Tauri plugins are aliased to stubs; keep the dep
    // optimizer from pre-bundling the real packages (whose imports reference
    // core exports the stub intentionally omits).
    exclude: isTauriBuild ? [] : ["@tauri-apps/plugin-notification", "@tauri-apps/plugin-shell", "@tauri-apps/plugin-dialog"],
  },
  // Tauri 2 targets modern WebView2 / WebKitGTK / WKWebView, all of which
  // support ES2022. Keep the production transform target explicit so xterm's
  // modern syntax is not down-leveled into older parser paths.
  build: {
    target: "es2022",
  },
  resolve: {
    alias: isTauriBuild
      ? {}
      : {
          "@tauri-apps/api/window": resolve(__dirname, "src/stubs/tauri-window.ts"),
          "@tauri-apps/api/core": resolve(__dirname, "src/stubs/tauri-core.ts"),
          "@tauri-apps/api/event": resolve(__dirname, "src/stubs/tauri-event.ts"),
          "@tauri-apps/plugin-shell": resolve(__dirname, "src/stubs/tauri-shell.ts"),
          "@tauri-apps/plugin-notification": resolve(__dirname, "src/stubs/tauri-notification.ts"),
          "@tauri-apps/plugin-dialog": resolve(__dirname, "src/stubs/tauri-dialog.ts"),
        },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: true,
  },
});
