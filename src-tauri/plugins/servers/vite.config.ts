import { serverSettingsConfig } from "../../../vite-plugins/serverSettings.ts";

export default serverSettingsConfig(import.meta.url, "LocalServerSettings.tsx");
