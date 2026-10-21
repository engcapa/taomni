import { useEffect, useState } from "react";
import { listWslDistros, listLocalShells, type WslDistro, type LocalShellOption } from "../../../lib/ipc";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import type { SessionConfig } from "../../../lib/ipc";
import { parseWslOptions, type WslOptions } from "../../../types/wsl";
import { parseLocalShellOptions, type LocalShellOptions } from "../../../types/localShell";
import { type Proto } from "./sessionPolicy";


export interface UseLocalShellFormContext {
  session: SessionConfig | undefined;
  proto: Proto;
}

export function useLocalShellForm(context: UseLocalShellFormContext) {
  const { session, proto } = context;

  /* --- local shell options --- */
  const [localShellOptions, setLocalShellOptions] = useState<LocalShellOptions>(() =>
    parseLocalShellOptions(session?.options_json),
  );
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [localShellStatus, setLocalShellStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (proto !== "Shell") return;
    let cancelled = false;
    setLocalShellStatus("loading");
    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        setLocalShells(shells);
        setLocalShellStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLocalShellStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [proto]);

  /* --- WSL options --- */
  const [wslOptions, setWslOptions] = useState<WslOptions>(() =>
    parseWslOptions(session?.options_json),
  );
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">(
    // WSL sessions need the desktop backend; the browser preview (even on a
    // Windows host) cannot launch them, so report unsupported there.
    () => (getAppPlatform() === "windows" && isTauriRuntime() ? "loading" : "unsupported"),
  );

  useEffect(() => {
    if (proto !== "WSL") return;
    if (getAppPlatform() !== "windows" || !isTauriRuntime()) {
      setWslStatus("unsupported");
      return;
    }
    let cancelled = false;
    setWslStatus("loading");
    listWslDistros()
      .then((distros) => {
        if (cancelled) return;
        const list = distros ?? [];
        setWslDistros(list);
        setWslStatus("ready");
        // If editing a brand-new session, default to the system's default distro.
        if (!wslOptions.distro && list.length > 0) {
          const def = list.find((d) => d.isDefault) ?? list[0];
          setWslOptions((prev) => ({ ...prev, distro: def.name }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setWslStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proto]);
  return { localShellOptions, wslOptions, setLocalShellOptions, setWslOptions, localShells, localShellStatus, wslDistros, wslStatus };
}
