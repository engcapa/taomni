import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTheme } from "../../lib/appTheme";
import { applyCodeViewProfile, loadCodeViewProfile, saveCodeViewProfile, type CodeViewProfile } from "../../lib/codeViewProfile";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";
import { clearPendingSettingsSection, consumePendingSettingsSection, OPEN_SETTINGS_SECTION_EVENT, type OpenSettingsSectionDetail } from "../../lib/settingsNavigation";
import { useSystemFonts } from "../../lib/systemFonts";
import { DEFAULT_TERMINAL_DEFAULT_PROFILE, DEFAULT_TERMINAL_PROFILE, loadTerminalDefaultProfile, saveTerminalDefaultProfile, type TerminalProfile } from "../../lib/terminalProfile";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { type FontPickerOption } from "../terminal/FontPickerPanel";
import { UI_FONTS } from "./panel/fonts";
import { type SettingsSearchContextValue } from "./panel/search";
import { SettingsPanelView } from "./panel/SettingsPanelView";
import { defaultExpandedGroups, groupIdForEntry, matchingGroupIds, matchingIds, SETTINGS_GROUPS } from "./settingsSearch";

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
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  const [query, setQuery] = useState("");
  const matchIds = useMemo(() => matchingIds(query, t), [query, t]);
  const matchKey = matchIds.join("|");
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRefs = useRef<Map<string, HTMLElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(defaultExpandedGroups);

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
    ensureGroupExpanded(id);
    // Expand may reflow; wait a frame so hidden=false is applied before scroll.
    window.requestAnimationFrame(() => {
      anchorRefs.current.get(id)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
  }, [ensureGroupExpanded]);

  const focusSection = useCallback((detail: OpenSettingsSectionDetail) => {
    ensureGroupExpanded(detail.id);
    let attempts = 0;
    let frame = 0;
    const run = () => {
      const anchor = anchorRefs.current.get(detail.id);
      if (anchor) {
        // Group body may still be `hidden` on the first frame after expand.
        const groupId = groupIdForEntry(detail.id);
        const body = groupId
          ? document.querySelector(`[data-testid="settings-group-body-${groupId}"]`)
          : null;
        if (body instanceof HTMLElement && body.hidden) {
          attempts += 1;
          if (attempts < 48) frame = window.requestAnimationFrame(run);
          return;
        }
        anchor.scrollIntoView({
          block: detail.presetId ? "start" : "center",
          behavior: attempts === 0 ? "auto" : "smooth",
        });
        if (!detail.presetId) clearPendingSettingsSection();
        return;
      }
      attempts += 1;
      if (attempts < 48) frame = window.requestAnimationFrame(run);
    };
    frame = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(frame);
  }, [ensureGroupExpanded]);

  // New query → expand matching groups, jump to the first match.
  useEffect(() => {
    setActiveIndex(0);
    if (matchIds.length === 0) return;
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
  }, [matchKey]);

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
  />;
}
