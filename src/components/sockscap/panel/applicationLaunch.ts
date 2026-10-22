import { sockscapLaunchApp, sockscapStopLaunchedApp, sockscapStop, type AppSelector, type LaunchedAppInfo, type LaunchPreparation, type SocksCapConfig, type SocksCapProfile, type SocksCapStatus } from "../../../lib/sockscap";
import { useAppStore } from "../../../stores/appStore";
import { type EnvironmentDraft } from "./configuration";
import { normalizeLaunchPreparation, launchPreparationIsEmpty, rootlessAppKey, parseShellArguments } from "./launchPolicy";

export interface CreateApplicationLaunchContext {
  cfg: SocksCapConfig | null;
  locked: boolean;
  rootlessCommand: string;
  rootlessArguments: string;
  report: (text: string, ok?: boolean) => void;
  t: import("../../../lib/i18n").TranslateFn;
  rootlessEnvironment: EnvironmentDraft[];
  rootlessWorkingDirectory: string;
  rootlessPreCommand: string;
  rootlessLaunchShell: "sh" | "bash";
  rootlessLaunchMode: "desktop" | "terminal";
  selectedProf: SocksCapProfile;
  editingRootlessAppKey: string | null;
  patchSelectedProfile: (partial: Partial<SocksCapProfile>) => Promise<SocksCapConfig | null>;
  resetRootlessApplicationDraft: () => void;
  launchingPath: string | null;
  stoppingPid: number | null;
  setLaunchingPath: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  running: boolean;
  persistConfig: (next: SocksCapConfig) => Promise<boolean>;
  preflightAndStart: (configOverride?: SocksCapConfig) => Promise<boolean>;
  setLaunchedApps: import("react").Dispatch<import("react").SetStateAction<LaunchedAppInfo[]>>;
  setStatus: import("react").Dispatch<import("react").SetStateAction<SocksCapStatus | null>>;
  setStoppingPid: import("react").Dispatch<import("react").SetStateAction<number | null>>;
  launchedApps: LaunchedAppInfo[];
  linuxLaunchOnly: boolean;
}

export function createApplicationLaunch(context: CreateApplicationLaunchContext) {
  const {
    cfg,
    locked,
    rootlessCommand,
    rootlessArguments,
    report,
    t,
    rootlessEnvironment,
    rootlessWorkingDirectory,
    rootlessPreCommand,
    rootlessLaunchShell,
    rootlessLaunchMode,
    selectedProf,
    editingRootlessAppKey,
    patchSelectedProfile,
    resetRootlessApplicationDraft,
    launchingPath,
    stoppingPid,
    setLaunchingPath,
    running,
    persistConfig,
    preflightAndStart,
    setLaunchedApps,
    setStatus,
    setStoppingPid,
    launchedApps,
    linuxLaunchOnly,
  } = context;

  const addRootlessApplication = async () => {
    if (!cfg || locked) return;
    const command = rootlessCommand.trim();
    if (!command) return;
    let args: string[];
    try {
      args = parseShellArguments(rootlessArguments);
    } catch {
      report(t("sockscap.rootlessArgsInvalid"), false);
      return;
    }
    const environment: Record<string, string> = {};
    for (const entry of rootlessEnvironment) {
      const name = entry.name.trim();
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        report(t("sockscap.rootlessEnvironmentInvalid"), false);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(environment, name)) {
        report(t("sockscap.rootlessEnvironmentDuplicate", { name }), false);
        return;
      }
      environment[name] = entry.value;
    }
    const workingDirectory = rootlessWorkingDirectory.trim();
    if (workingDirectory && !workingDirectory.startsWith("/")) {
      report(t("sockscap.rootlessWorkingDirectoryAbsolute"), false);
      return;
    }
    const launchPreparation = normalizeLaunchPreparation({
      workingDirectory,
      environment,
      preCommand: rootlessPreCommand.trim(),
      shell: rootlessLaunchShell,
    });
    const candidate: AppSelector = {
      path: command,
      args,
      launchMode: rootlessLaunchMode,
      ...(launchPreparationIsEmpty(launchPreparation) ? {} : { launchPreparation }),
      name: command.split(/[/\\]/).pop() || command,
    };
    const key = rootlessAppKey(
      candidate.path,
      candidate.args,
      candidate.launchMode,
      candidate.launchPreparation,
    );
    if (
      selectedProf.apps.some(
        (app) =>
          rootlessAppKey(
            app.path,
            app.args,
            app.launchMode,
            app.launchPreparation,
          ) === key &&
          rootlessAppKey(
            app.path,
            app.args,
            app.launchMode,
            app.launchPreparation,
          ) !== editingRootlessAppKey,
      )
    ) {
      report(t("sockscap.rootlessAppAlreadyAdded"), false);
      return;
    }
    const apps = editingRootlessAppKey
      ? selectedProf.apps.map((app) =>
          rootlessAppKey(
            app.path,
            app.args,
            app.launchMode,
            app.launchPreparation,
          ) === editingRootlessAppKey
            ? candidate
            : app,
        )
      : [...selectedProf.apps, candidate];
    const nextConfig = await patchSelectedProfile({ apps });
    if (nextConfig) {
      resetRootlessApplicationDraft();
    }
  };

  const onRootlessLaunchApp = async (
    profileId: string,
    path: string,
    args: string[] = [],
    launchMode: "desktop" | "terminal" = "desktop",
    launchPreparation: LaunchPreparation = {},
    name?: string,
    configOverride?: SocksCapConfig,
  ) => {
    if (launchingPath || stoppingPid !== null) return;
    const launchKey = rootlessAppKey(path, args, launchMode, launchPreparation);
    setLaunchingPath(launchKey);
    let startedHere = false;
    try {
      let launchConfig = configOverride ?? cfg;
      if (!running) {
        const targetProfile = launchConfig?.profiles.find(
          (profile) => profile.id === profileId,
        );
        if (launchConfig && targetProfile) {
          const profileActive =
            targetProfile.enabled &&
            launchConfig.activeProfileIds.length === 1 &&
            launchConfig.activeProfileIds[0] === profileId;
          if (!profileActive) {
            launchConfig = {
              ...launchConfig,
              profiles: launchConfig.profiles.map((profile) =>
                profile.id === profileId ? { ...profile, enabled: true } : profile,
              ),
              activeProfileIds: [profileId],
            };
            if (!(await persistConfig(launchConfig))) return;
          }
        }
        const started = await preflightAndStart(launchConfig ?? undefined);
        if (!started) return;
        startedHere = true;
      }
      if (launchMode === "terminal") {
        const id = `sockscap-terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        useAppStore.getState().addTab({
          id,
          type: "terminal",
          title: name || path.split(/[/\\]/).pop() || path,
          closable: true,
          sockscapTerminal: {
            profileId,
            path,
            args,
            launchPreparation,
            terminalSessionId: id,
          },
          terminalTitleMode: "manual",
        });
        report(t("sockscap.terminalApplicationOpened"));
        return;
      }
      const launched = await sockscapLaunchApp(
        profileId,
        path,
        args,
        launchPreparation,
      );
      setLaunchedApps((current) => [
        ...current.filter((app) => app.pid !== launched.pid),
        launched,
      ]);
      report(t("sockscap.applicationLaunched", { pid: launched.pid }));
    } catch (e) {
      report(String(e), false);
      if (startedHere) {
        const stopped = await sockscapStop().catch(() => null);
        if (stopped) setStatus(stopped);
      }
    } finally {
      setLaunchingPath(null);
    }
  };

  const onStopLaunchedApp = async (pid: number) => {
    if (launchingPath || stoppingPid !== null) return;
    setStoppingPid(pid);
    try {
      await sockscapStopLaunchedApp(pid);
      const remaining = launchedApps.filter((app) => app.running && app.pid !== pid);
      setLaunchedApps((current) =>
        current.map((app) => (app.pid === pid ? { ...app, running: false } : app)),
      );
      if (linuxLaunchOnly && remaining.length === 0) {
        const stopped = await sockscapStop();
        setStatus(stopped);
        setLaunchedApps([]);
      }
      report(t("sockscap.applicationStopped", { pid }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setStoppingPid(null);
    }
  };
  return {
    addRootlessApplication,
    onStopLaunchedApp,
    onRootlessLaunchApp,
  };
}
