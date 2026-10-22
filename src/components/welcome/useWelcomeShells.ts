import { useState, useEffect, useMemo } from "react";
import { listLocalShells, listWslDistros, type LocalShellOption, type WslDistro } from "../../lib/ipc";
import { useWelcomeDirectories } from "../../hooks/useWelcomeDirectories";
import { getAppPlatform } from "../../lib/runtime";


export interface UseWelcomeShellsContext {
  setStatusMessage: (message: string) => void;
  t: import("../../lib/i18n").TranslateFn;
  active: boolean;
}

export function useWelcomeShells(context: UseWelcomeShellsContext) {
  const { setStatusMessage, t, active } = context;

  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [selectedShellId, setSelectedShellId] = useState("");
  const [shellStatus, setShellStatus] = useState<"loading" | "ready" | "error">("loading");
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [selectedDistro, setSelectedDistro] = useState("");
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">("loading");


  useEffect(() => {
    let cancelled = false;

    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        const list = Array.isArray(shells) ? shells : [];
        setLocalShells(list);
        setSelectedShellId(list.find((shell) => shell.isDefault)?.id ?? list[0]?.id ?? "");
        setShellStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setShellStatus("error");
        setStatusMessage(t("status.localShellDetectionFailed", { error: String(error) }));
      });

    if (getAppPlatform() === "windows") {
      listWslDistros()
        .then((distros) => {
          if (cancelled) return;
          const list = Array.isArray(distros) ? distros : [];
          setWslDistros(list);
          setSelectedDistro(list.find((d) => d.isDefault)?.name ?? list[0]?.name ?? "");
          setWslStatus("ready");
        })
        .catch((error) => {
          if (cancelled) return;
          setWslStatus("error");
          setStatusMessage(t("welcome.wslDetectFailed", { error: String(error) }));
        });
    } else {
      setWslStatus("unsupported");
    }

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, t]);

  // Welcome stays mounted across tab switches; the directories hook reloads
  // whenever the tab becomes visible (and honors backend revision events).
  const {
    directories: localDirectories,
    status: directoriesStatus,
    error: directoriesError,
    reload: reloadDirectories,
  } = useWelcomeDirectories(active);

  const mergedShells = useMemo<LocalShellOption[]>(() => {
    if (wslDistros.length === 0) return localShells;
    const virtual: LocalShellOption[] = wslDistros.map((d) => ({
      id: `wsl:${d.name}`,
      name: `WSL: ${d.name}`,
      path: "wsl.exe",
      args: ["-d", d.name],
      isDefault: false,
      canElevate: true,
    }));
    return [...localShells, ...virtual];
  }, [localShells, wslDistros]);

  const selectedShell = useMemo(
    () => mergedShells.find((shell) => shell.id === selectedShellId),
    [mergedShells, selectedShellId],
  );
  return { selectedShell, mergedShells, localDirectories, directoriesStatus, directoriesError, reloadDirectories, localShells, setLocalShells, selectedShellId, setSelectedShellId, shellStatus, setShellStatus, wslDistros, setWslDistros, selectedDistro, setSelectedDistro, wslStatus, setWslStatus };
}
