import { useRef, useState } from "react";
import { type AppSelector } from "../../../lib/sockscap";
import { open } from "@tauri-apps/plugin-dialog";
import { type EnvironmentDraft } from "./configuration";
import { normalizeLaunchPreparation, formatRootlessArguments, launchPreparationIsEmpty, rootlessAppKey } from "./launchPolicy";


export interface UseRootlessApplicationDraftContext {
  locked: boolean;
  report: (text: string, ok?: boolean) => void;
}

export function useRootlessApplicationDraft(context: UseRootlessApplicationDraftContext) {
  const { locked, report } = context;
  const [rootlessCommand, setRootlessCommand] = useState("");
  const [rootlessArguments, setRootlessArguments] = useState("");
  const [rootlessLaunchMode, setRootlessLaunchMode] =
    useState<"desktop" | "terminal">("desktop");
  const [rootlessPreparationOpen, setRootlessPreparationOpen] = useState(false);
  const [rootlessWorkingDirectory, setRootlessWorkingDirectory] = useState("");
  const [rootlessPreCommand, setRootlessPreCommand] = useState("");
  const [rootlessLaunchShell, setRootlessLaunchShell] =
    useState<"sh" | "bash">("sh");
  const [rootlessEnvironment, setRootlessEnvironment] = useState<EnvironmentDraft[]>([]);
  const [editingRootlessAppKey, setEditingRootlessAppKey] = useState<string | null>(null);
  const nextEnvironmentDraftId = useRef(1);

  const pickRootlessApplication = async () => {
    if (locked) return;
    try {
      const selected = await open({ multiple: false });
      if (!selected || Array.isArray(selected)) return;
      setRootlessCommand(selected);
    } catch (e) {
      report(String(e), false);
    }
  };

  const pickRootlessWorkingDirectory = async () => {
    if (locked) return;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return;
      setRootlessWorkingDirectory(selected);
      setRootlessPreparationOpen(true);
    } catch (e) {
      report(String(e), false);
    }
  };

  const resetRootlessApplicationDraft = () => {
    setRootlessCommand("");
    setRootlessArguments("");
    setRootlessLaunchMode("desktop");
    setRootlessPreparationOpen(false);
    setRootlessWorkingDirectory("");
    setRootlessPreCommand("");
    setRootlessLaunchShell("sh");
    setRootlessEnvironment([]);
    setEditingRootlessAppKey(null);
  };

  const editRootlessApplication = (app: AppSelector) => {
    const preparation = normalizeLaunchPreparation(app.launchPreparation);
    setRootlessCommand(app.path);
    setRootlessArguments(formatRootlessArguments(app.args));
    setRootlessLaunchMode(app.launchMode ?? "desktop");
    setRootlessWorkingDirectory(preparation.workingDirectory ?? "");
    setRootlessPreCommand(preparation.preCommand ?? "");
    setRootlessLaunchShell(preparation.shell ?? "sh");
    setRootlessEnvironment(
      Object.entries(preparation.environment ?? {}).map(([name, value]) => ({
        id: nextEnvironmentDraftId.current++,
        name,
        value,
      })),
    );
    setRootlessPreparationOpen(!launchPreparationIsEmpty(preparation));
    setEditingRootlessAppKey(
      rootlessAppKey(app.path, app.args, app.launchMode, app.launchPreparation),
    );
  };
  return { rootlessCommand, rootlessArguments, rootlessEnvironment, rootlessWorkingDirectory, rootlessPreCommand, rootlessLaunchShell, rootlessLaunchMode, editingRootlessAppKey, resetRootlessApplicationDraft, setRootlessCommand, pickRootlessApplication, setRootlessArguments, setRootlessLaunchMode, rootlessPreparationOpen, setRootlessPreparationOpen, setRootlessWorkingDirectory, pickRootlessWorkingDirectory, setRootlessLaunchShell, setRootlessPreCommand, setRootlessEnvironment, nextEnvironmentDraftId, editRootlessApplication };
}
