import { useCallback, useRef, useState } from "react";
import { sockscapGetConfig, sockscapSetConfig, type SocksCapConfig } from "../../../../../src/lib/sockscap";
import { DEFAULT_CFG, normalizeFrontendConfig } from "./configuration";

// A reopened panel can read while its previous instance is finishing a save.
let lastWrite = Promise.resolve();

export function useProfileConfig() {
  const [cfg, setCfg] = useState<SocksCapConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const confirmed = useRef<SocksCapConfig | null>(null);
  const edit = useRef(0);
  const read = useRef(0);

  const load = useCallback(async () => {
    const request = ++read.current;
    await lastWrite;
    const config = await sockscapGetConfig().then(normalizeFrontendConfig)
      .catch(() => confirmed.current ?? DEFAULT_CFG);
    // Publish alongside the platform capabilities and capture lock state.
    return () => {
      if (read.current === request) {
        confirmed.current = config;
        setCfg(config);
      }
    };
  }, []);

  const select = useCallback((config: SocksCapConfig) => {
    ++read.current;
    setCfg(config);
  }, []);

  const save = useCallback(async (config: SocksCapConfig) => {
    const change = ++edit.current;
    ++read.current;
    setCfg(config);
    setSaving(true);
    const write = lastWrite.then(() => sockscapSetConfig(config));
    lastWrite = write.catch(() => {});
    try {
      await write;
      confirmed.current = config;
    } catch (error) {
      if (edit.current === change) {
        const previous = confirmed.current;
        setCfg(current => current && previous
          ? normalizeFrontendConfig({ ...previous, selectedProfileId: current.selectedProfileId })
          : previous);
      }
      throw error;
    } finally {
      if (edit.current === change) setSaving(false);
    }
  }, []);

  return { cfg, saving, load, select, save };
}
