import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTheme } from "../../lib/appTheme";
import { applyCodeViewProfile, loadCodeViewProfile, saveCodeViewProfile, type CodeViewProfile } from "../../lib/codeViewProfile";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";
import { executePluginMigration, inspectLegacyInstall, installStagedPlugin, listPlugins, rollbackPlugin, setPluginEnabled, uninstallPlugin } from "../../lib/ipc";
import type { LegacyInstallSnapshot, MigrationExecutionResult } from "../../lib/ipc";
import { PLUGIN_CORE_API_VERSION, type PluginRecord } from "../../lib/pluginRegistry";
import { clearPendingSettingsSection, consumePendingSettingsSection, OPEN_SETTINGS_SECTION_EVENT, type OpenSettingsSectionDetail } from "../../lib/settingsNavigation";
import { useSystemFonts } from "../../lib/systemFonts";
import { DEFAULT_TERMINAL_DEFAULT_PROFILE, DEFAULT_TERMINAL_PROFILE, loadTerminalDefaultProfile, saveTerminalDefaultProfile, type TerminalProfile } from "../../lib/terminalProfile";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { projectModuleRecord, useModuleStore } from "../../stores/moduleStore";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { type FontPickerOption } from "../terminal/FontPickerPanel";
import { type ModuleStoreCatalogEntry } from "./ModuleStorePanel";
import { UI_FONTS } from "./panel/fonts";
import { type SettingsSearchContextValue } from "./panel/search";
import { SettingsPanelView } from "./panel/SettingsPanelView";
import { revealSettingsSection } from "./panel/sectionReveal";
import { defaultExpandedGroups, groupIdForEntry, matchingGroupIds, matchingIds, SETTINGS_GROUPS } from "./settingsSearch";

function moduleCatalogEntry(record: PluginRecord): ModuleStoreCatalogEntry | null {
  const manifest = record.manifest;
  if (!manifest) return null;
  return {
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description || `${manifest.kind} module`,
    version: manifest.version,
    coreApiVersion: manifest.coreApiVersion,
    permissions: manifest.permissions,
  };
}

export function SettingsPanel() {
  const [codeViewProfile, setCodeViewProfile] = useState<CodeViewProfile>(() => loadCodeViewProfile());
  const [terminalDefaultProfile, setTerminalDefaultProfile] = useState<TerminalProfile>(
    () => loadTerminalDefaultProfile(),
  );
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const mergeToolWindowRail = useAppStore((s) => s.mergeToolWindowRail);
  const setMergeToolWindowRail = useAppStore((s) => s.setMergeToolWindowRail);
  const welcomeRecentSessionLimit = useAppStore((s) => s.welcomeRecentSessionLimit);
  const setUiFontFamily = useAppStore((s) => s.setUiFontFamily);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const setWelcomeRecentSessionLimit = useAppStore((s) => s.setWelcomeRecentSessionLimit);
  const [fontCatalogRequested, setFontCatalogRequested] = useState(false);
  const systemFonts = useSystemFonts(fontCatalogRequested);
  const voiceShellEnabled = useAiStore((s) => s.voiceShellEnabled);
  const toggleVoiceShell = useAiStore((s) => s.toggleVoiceShell);
  const hydrateModuleStore = useModuleStore((s) => s.hydrate);
  const [moduleCatalog, setModuleCatalog] = useState<ModuleStoreCatalogEntry[]>([]);
  const [moduleCatalogLoading, setModuleCatalogLoading] = useState(true);
  const [moduleCatalogError, setModuleCatalogError] = useState<string | null>(null);
  const [moduleRefreshRevision, setModuleRefreshRevision] = useState(0);
  const refreshModuleCatalog = useCallback(() => setModuleRefreshRevision((revision) => revision + 1), []);
  useEffect(() => usePluginFrontendStore.subscribe((next, previous) => {
    if (next.records !== previous.records) refreshModuleCatalog();
  }), [refreshModuleCatalog]);
  const [migrationSnapshot, setMigrationSnapshot] = useState<LegacyInstallSnapshot | null>(null);
  const [migrationLoading, setMigrationLoading] = useState(true);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] = useState<MigrationExecutionResult | null>(null);
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  const [query, setQuery] = useState("");
  const matchIds = useMemo(() => matchingIds(query, t), [query, t]);
  const matchKey = matchIds.join("|");
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(defaultExpandedGroups);
  const sectionReveal = useRef<(() => void) | undefined>(undefined);
  const stopSectionReveal = useCallback(() => {
    sectionReveal.current?.();
    sectionReveal.current = undefined;
  }, []);
  useEffect(() => stopSectionReveal, [stopSectionReveal]);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) anchorRefs.current.set(id, el);
    else anchorRefs.current.delete(id);
  }, []);

  const ensureGroupExpanded = useCallback((entryId: string | undefined) => {
    if (!entryId) return;
    const groupId = groupIdForEntry(entryId);
    if (!groupId) return;
    setExpandedGroups((prev) => {
      if (prev[groupId]) return prev;
      return { ...prev, [groupId]: true };
    });
  }, []);

  const scrollToId = useCallback((id: string | undefined) => {
    if (!id) return;
    stopSectionReveal();
    ensureGroupExpanded(id);
    // Search can expand asynchronous controls above the match. Keep the same
    // layout ownership as deep links until the next query or user input.
    sectionReveal.current = revealSettingsSection({
      resolveAnchor: () => anchorRefs.current.get(id),
      maintainLayout: true,
      onReveal: () => {},
    });
  }, [ensureGroupExpanded, stopSectionReveal]);

  const focusSection = useCallback((detail: OpenSettingsSectionDetail) => {
    stopSectionReveal();
    ensureGroupExpanded(detail.id);
    const dispose = revealSettingsSection({
      resolveAnchor: () => anchorRefs.current.get(detail.id),
      maintainLayout: !detail.presetId,
      onReveal: () => { if (!detail.presetId) clearPendingSettingsSection(); },
    });
    sectionReveal.current = dispose;
    return dispose;
  }, [ensureGroupExpanded, stopSectionReveal]);

  // New query → expand matching groups, jump to the first match.
  useEffect(() => {
    setActiveIndex(0);
    if (matchIds.length === 0) { stopSectionReveal(); return; }
    const groups = matchingGroupIds(matchIds);
    setExpandedGroups((prev) => {
      const next = { ...prev };
      for (const g of SETTINGS_GROUPS) {
        // While searching, open groups with hits so matches are reachable;
        // leave other groups as the user left them (usually collapsed after browse).
        if (groups.includes(g.id)) next[g.id] = true;
      }
      return next;
    });
    scrollToId(matchIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, query]);

  // Status bar / deep links: open Settings and scroll to a section.
  useEffect(() => {
    const onOpenSection = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsSectionDetail>).detail;
      if (!detail?.id) return;
      focusSection(detail);
    };
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSection as EventListener);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpenSection as EventListener);
  }, [focusSection]);

  // Settings tab may mount after the navigation event (first open).
  useEffect(() => {
    const pending = consumePendingSettingsSection();
    if (!pending?.id) return;
    return focusSection(pending);
  }, [focusSection]);

  const goToMatch = useCallback(
    (delta: number) => {
      if (matchIds.length === 0) return;
      setActiveIndex((prev) => {
        const next = (prev + delta + matchIds.length) % matchIds.length;
        scrollToId(matchIds[next]);
        return next;
      });
    },
    [matchIds, scrollToId],
  );
  const searching = query.trim().length > 0;
  const clampedIndex = matchIds.length > 0 ? Math.min(activeIndex, matchIds.length - 1) : 0;
  const activeId = matchIds[clampedIndex] ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matchedSet = useMemo(() => new Set(matchIds), [matchKey]);
  const matchedGroupIds = useMemo(() => matchingGroupIds(matchIds), [matchKey]);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const matchCountByGroup = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const g of SETTINGS_GROUPS) counts[g.id] = 0;
    for (const id of matchIds) {
      const g = groupIdForEntry(id);
      if (g) counts[g] = (counts[g] ?? 0) + 1;
    }
    return counts;
  }, [matchKey]);

  const ctxValue = useMemo<SettingsSearchContextValue>(
    () => ({ searching, matchedSet, activeId, register }),
    [searching, matchedSet, activeId, register],
  );

  const currentSelectValue = useMemo(() => {
    if (UI_FONTS.some((f) => f.value === uiFontFamily)) {
      return uiFontFamily;
    }
    const primary = uiFontFamily.replace(/['"]/g, "").split(",")[0].trim().toLowerCase();
    const sysMatch = systemFonts.fonts.find((f) => f.toLowerCase() === primary);
    if (sysMatch) {
      return `"${sysMatch}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    }
    return uiFontFamily;
  }, [uiFontFamily, systemFonts.fonts]);
  const uiFontOptions = useMemo<FontPickerOption[]>(() => {
    const options: FontPickerOption[] = [
      ...UI_FONTS.map((font) => ({
        value: font.value,
        label: font.label,
        fontFamily: font.value,
        group: "curated",
      })),
      ...systemFonts.fonts.map((font) => ({
        value: `"${font}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
        label: font,
        fontFamily: `"${font}", sans-serif`,
        group: "system",
      })),
    ];
    if (!options.some((option) => option.value === currentSelectValue)) {
      const label = currentSelectValue.replace(/["']/g, "").split(",")[0]?.trim() || currentSelectValue;
      options.unshift({
        value: currentSelectValue,
        label,
        fontFamily: currentSelectValue,
        group: "current",
      });
    }
    return options;
  }, [currentSelectValue, systemFonts.fonts]);
  const uiFontGroupLabels = useMemo(() => ({
    current: "",
    curated: t("settings.fontFamilyCurated"),
    system: t("settings.fontFamilySystem"),
  }), [t]);
  const requestSystemFonts = useCallback(() => setFontCatalogRequested(true), []);

  useEffect(() => {
    applyCodeViewProfile(codeViewProfile, DEFAULT_TERMINAL_PROFILE, { resolvedAppTheme: resolvedTheme });
  }, [codeViewProfile, resolvedTheme]);

  useEffect(() => {
    saveCodeViewProfile(codeViewProfile);
  }, [codeViewProfile]);

  const handleTerminalDefaultProfileChange = useCallback((profile: TerminalProfile) => {
    setTerminalDefaultProfile(profile);
    saveTerminalDefaultProfile(profile);
  }, []);

  const resetTerminalDefaultProfile = useCallback(() => {
    setTerminalDefaultProfile(DEFAULT_TERMINAL_DEFAULT_PROFILE);
    saveTerminalDefaultProfile(DEFAULT_TERMINAL_DEFAULT_PROFILE);
  }, []);

  useEffect(() => {
    let mounted = true;
    setModuleCatalogLoading(true);
    listPlugins()
      .then((records) => {
        if (!mounted) return;
        hydrateModuleStore(records.map(projectModuleRecord));
        setModuleCatalog(records.map(moduleCatalogEntry).filter((entry): entry is ModuleStoreCatalogEntry => entry !== null));
        setModuleCatalogError(null);
      })
      .catch((reason) => {
        if (!mounted) return;
        setModuleCatalogError(reason instanceof Error ? reason.message : String(reason));
        hydrateModuleStore([]);
      })
      .finally(() => {
        if (mounted) setModuleCatalogLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [hydrateModuleStore, moduleRefreshRevision]);

  useEffect(() => {
    let mounted = true;
    setMigrationLoading(true);
    inspectLegacyInstall()
      .then((snapshot) => {
        if (mounted) {
          setMigrationSnapshot(snapshot);
          setMigrationResult(null);
          setMigrationError(null);
        }
      })
      .catch((reason) => {
        if (mounted) setMigrationError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (mounted) setMigrationLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const moduleOnInstall = useCallback(async (entry: ModuleStoreCatalogEntry) => {
    // The signed catalog/download bridge will provide a verified staging path.
    // Until then, fail explicitly instead of advancing only the renderer state.
    const packageDir = (entry as ModuleStoreCatalogEntry & { packageDir?: string }).packageDir;
    if (!packageDir) {
      const release = useModuleMarketplaceStore.getState().catalog?.release;
      if (entry.slug === "mail" && release?.legacyRestartRequired?.includes("taomni-plugin-mail")) {
        throw new Error(t("plugins.marketMailRestartRequired"));
      }
      throw new Error(t("settings.moduleStoreInstallFromMarketplace"));
    }
    await installStagedPlugin(entry.slug, entry.version, packageDir);
  }, [t]);
  const moduleOnEnable = useCallback(async (entry: ModuleStoreCatalogEntry) => {
    await setPluginEnabled(entry.slug, true);
  }, []);
  const moduleOnDisable = useCallback(async (entry: ModuleStoreCatalogEntry) => {
    await setPluginEnabled(entry.slug, false);
  }, []);
  const moduleOnUninstall = useCallback(async (entry: ModuleStoreCatalogEntry, deleteData: boolean) => {
    await uninstallPlugin(entry.slug, deleteData);
  }, []);
  const moduleOnRollback = useCallback(async (entry: ModuleStoreCatalogEntry, version: string) =>
    projectModuleRecord(await rollbackPlugin(entry.slug, version)), []);
  const moduleOnMigrationExecute = useCallback(async () => {
    try {
      const result = await executePluginMigration(migrationSnapshot?.from_version);
      setMigrationResult(result);
      const refreshed = await inspectLegacyInstall(migrationSnapshot?.from_version);
      setMigrationSnapshot(refreshed);
      setMigrationError(null);
    } catch (reason) {
      setMigrationError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, [migrationSnapshot?.from_version]);

  const groupTitle = useCallback((titleKey: string) => t(titleKey), [t]);

  return <SettingsPanelView
    ctxValue={ctxValue}
    t={t}
    searchInputRef={searchInputRef}
    query={query}
    setQuery={setQuery}
    goToMatch={goToMatch}
    searching={searching}
    matchIds={matchIds}
    clampedIndex={clampedIndex}
    matchedGroupIds={matchedGroupIds}
    groupTitle={groupTitle}
    expandedGroups={expandedGroups}
    toggleGroup={toggleGroup}
    matchCountByGroup={matchCountByGroup}
    themeLabel={themeLabel}
    mode={mode}
    resolvedTheme={resolvedTheme}
    welcomeRecentSessionLimit={welcomeRecentSessionLimit}
    setWelcomeRecentSessionLimit={setWelcomeRecentSessionLimit}
    setUiFontFamily={setUiFontFamily}
    setUiFontSize={setUiFontSize}
    uiFontOptions={uiFontOptions}
    currentSelectValue={currentSelectValue}
    uiFontGroupLabels={uiFontGroupLabels}
    fontCatalogRequested={fontCatalogRequested}
    systemFonts={systemFonts}
    requestSystemFonts={requestSystemFonts}
    uiFontSize={uiFontSize}
    mergeToolWindowRail={mergeToolWindowRail}
    setMergeToolWindowRail={setMergeToolWindowRail}
    setCodeViewProfile={setCodeViewProfile}
    codeViewProfile={codeViewProfile}
    resetTerminalDefaultProfile={resetTerminalDefaultProfile}
    terminalDefaultProfile={terminalDefaultProfile}
    handleTerminalDefaultProfileChange={handleTerminalDefaultProfileChange}
    voiceShellEnabled={voiceShellEnabled}
    toggleVoiceShell={toggleVoiceShell}
    moduleCatalog={moduleCatalog}
    moduleCoreApiVersion={PLUGIN_CORE_API_VERSION}
    moduleCatalogLoading={moduleCatalogLoading}
    moduleCatalogError={moduleCatalogError}
    onModuleRegistryChanged={refreshModuleCatalog}
    moduleOnInstall={moduleOnInstall}
    moduleOnEnable={moduleOnEnable}
    moduleOnDisable={moduleOnDisable}
    moduleOnUninstall={moduleOnUninstall}
    moduleOnRollback={moduleOnRollback}
    migrationSnapshot={migrationSnapshot}
    migrationLoading={migrationLoading}
    migrationError={migrationError}
    migrationResult={migrationResult}
    onMigrationExecute={moduleOnMigrationExecute}
  />;
}
