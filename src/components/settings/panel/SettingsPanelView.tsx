import { Bot, ChevronDown, ChevronUp, History, RotateCcw, Search, Terminal, Type, Undo } from "lucide-react";
import { DEFAULT_CODE_VIEW_PROFILE, type CodeViewProfile } from "../../../lib/codeViewProfile";
import { useT } from "../../../lib/i18n";
import { useAppThemeI18nLabel } from "../../../lib/i18n/labels";
import { useSystemFonts } from "../../../lib/systemFonts";
import { DEFAULT_TERMINAL_PROFILE, type TerminalProfile } from "../../../lib/terminalProfile";
import { FontPickerSelect, type FontPickerOption } from "../../terminal/FontPickerPanel";
import { TerminalAppearanceSettings } from "../../terminal/TerminalAppearanceSettings";
import { VaultSettings } from "../../vault/VaultSettings";
import { AcpAgentsPanel } from "../AcpAgentsPanel";
import { AiMasterSwitch } from "../AiMasterSwitch";
import { AiShellPanel } from "../AiShellPanel";
import { AppProxyPanel } from "../AppProxyPanel";
import { AppThemeSwitcher } from "../AppThemeSwitcher";
import { AsrPanel } from "../AsrPanel";
import { BackupSettingsPanel } from "../BackupSettingsPanel";
import { ChatHistoryPanel } from "../ChatHistoryPanel";
import { ChatOutputFormatPanel } from "../ChatOutputFormatPanel";
import { ChatSendShortcutPanel } from "../ChatSendShortcutPanel";
import { ClaudeCodePanel } from "../ClaudeCodePanel";
import { CodeViewAppearanceSettings } from "../CodeViewAppearanceSettings";
import { CodexCodePanel } from "../CodexCodePanel";
import { EditorAiLanguagePanel } from "../EditorAiLanguagePanel";
import { LanChatSettings } from "../LanChatSettings";
import { LanguageSection } from "../LanguageSection";
import { LanguageServersSettings } from "../LanguageServersSettings";
import { LiveTemplatesSettings } from "../LiveTemplatesSettings";
import { LlmProvidersPanel } from "../LlmProvidersPanel";
import { ModelsAdvancedPanel } from "../ModelsAdvancedPanel";
import { PrivacyToggle } from "../PrivacyToggle";
import { ScreenshotSettings } from "../ScreenshotSettings";
import { SdkSettings } from "../SdkSettings";
import { SftpSettings } from "../SftpSettings";
import { SqlCompletionSettings } from "../SqlCompletionSettings";
import { SqlExecutionSettings } from "../SqlExecutionSettings";
import { WebSearchPanel } from "../WebSearchPanel";
import { SettingsAnchor, SettingsGroup, SettingsSearchContext, type SettingsSearchContextValue } from "./search";

export interface SettingsPanelViewProps {
  ctxValue: SettingsSearchContextValue;
  t: ReturnType<typeof useT>;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: import("react").Dispatch<import("react").SetStateAction<string>>;
  goToMatch: (delta: number) => void;
  searching: boolean;
  matchIds: string[];
  clampedIndex: number;
  matchedGroupIds: string[];
  groupTitle: (titleKey: string) => string;
  expandedGroups: Record<string, boolean>;
  toggleGroup: (groupId: string) => void;
  matchCountByGroup: Record<string, number>;
  themeLabel: ReturnType<typeof useAppThemeI18nLabel>;
  mode: import("../../../lib/appTheme").AppThemeMode;
  resolvedTheme: import("../../../lib/appTheme").ResolvedAppTheme;
  welcomeRecentSessionLimit: number;
  setWelcomeRecentSessionLimit: (limit: number) => void;
  setUiFontFamily: (font: string) => void;
  setUiFontSize: (size: number) => void;
  uiFontOptions: FontPickerOption[];
  currentSelectValue: string;
  uiFontGroupLabels: { current: string; curated: string; system: string; };
  fontCatalogRequested: boolean;
  systemFonts: ReturnType<typeof useSystemFonts>;
  requestSystemFonts: () => void;
  uiFontSize: number;
  mergeToolWindowRail: boolean;
  setMergeToolWindowRail: (value: boolean) => void;
  setCodeViewProfile: import("react").Dispatch<import("react").SetStateAction<CodeViewProfile>>;
  codeViewProfile: CodeViewProfile;
  resetTerminalDefaultProfile: () => void;
  terminalDefaultProfile: TerminalProfile;
  handleTerminalDefaultProfileChange: (profile: TerminalProfile) => void;
  voiceShellEnabled: boolean;
  toggleVoiceShell: () => void;
}

export function SettingsPanelView(inputs: SettingsPanelViewProps) {
  const {
    ctxValue,
    t,
    searchInputRef,
    query,
    setQuery,
    goToMatch,
    searching,
    matchIds,
    clampedIndex,
    matchedGroupIds,
    groupTitle,
    expandedGroups,
    toggleGroup,
    matchCountByGroup,
    themeLabel,
    mode,
    resolvedTheme,
    welcomeRecentSessionLimit,
    setWelcomeRecentSessionLimit,
    setUiFontFamily,
    setUiFontSize,
    uiFontOptions,
    currentSelectValue,
    uiFontGroupLabels,
    fontCatalogRequested,
    systemFonts,
    requestSystemFonts,
    uiFontSize,
    mergeToolWindowRail,
    setMergeToolWindowRail,
    setCodeViewProfile,
    codeViewProfile,
    resetTerminalDefaultProfile,
    terminalDefaultProfile,
    handleTerminalDefaultProfileChange,
    voiceShellEnabled,
    toggleVoiceShell,
  } = inputs;
  return ((
    <SettingsSearchContext.Provider value={ctxValue}>
      <div
        data-testid="settings-panel"
        className="h-full overflow-auto"
        style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
      >
        <div className="mx-auto max-w-5xl p-5">
          <div className="mb-3">
            <div className="text-[18px] font-semibold">{t("settings.title")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("settings.subtitle")}
            </div>
          </div>
          <div
            className="sticky top-0 z-20 -mx-5 mb-4 px-5 pb-3 pt-1"
            style={{ background: "var(--taomni-bg)" }}
          >
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
                <input
                  ref={searchInputRef}
                  data-testid="settings-search-input"
                  type="search"
                  className="taomni-input h-8 w-full"
                  style={{ paddingLeft: "2rem" }}
                  placeholder={t("settings.searchPlaceholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goToMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setQuery("");
                    }
                  }}
                />
              </div>
              {searching && matchIds.length > 0 && (
                <div className="flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
                  <span data-testid="settings-search-count" className="tabular-nums">
                    {t("settings.searchResultCount", { current: clampedIndex + 1, total: matchIds.length })}
                  </span>
                  {matchedGroupIds.length > 1 && (
                    <span
                      data-testid="settings-search-group-count"
                      className="tabular-nums text-[var(--taomni-text-muted)]"
                      title={t("settings.searchGroupHint")}
                    >
                      · {t("settings.searchGroupCount", { count: matchedGroupIds.length })}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t("settings.searchPrev")}
                    className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                    onClick={() => goToMatch(-1)}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("settings.searchNext")}
                    className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                    onClick={() => goToMatch(1)}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            {searching && matchIds.length === 0 && (
              <div
                data-testid="settings-search-empty"
                className="mt-2 text-[12px] text-[var(--taomni-text-muted)]"
              >
                {t("settings.searchNoResults", { query })}
              </div>
            )}
          </div>

          {/* —— General —— */}
          <SettingsGroup
            id="general"
            title={groupTitle("settings.groupGeneral")}
            expanded={!!expandedGroups.general}
            onToggle={() => toggleGroup("general")}
            matchCount={matchCountByGroup.general ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="language">
              <LanguageSection />
            </SettingsAnchor>
            <SettingsAnchor id="app-theme">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-2 flex items-center gap-3">
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.appThemeTitle")}</div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.appThemeCurrent", { mode: themeLabel(mode), resolved: resolvedTheme })}
                    </div>
                  </div>
                </div>
                <AppThemeSwitcher />
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="welcome-history">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-3 flex items-center gap-3">
                  <History className="w-4 h-4 text-[var(--taomni-accent)]" />
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.welcomeHistoryTitle")}</div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.welcomeHistorySubtitle")}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-2 border-t border-[var(--taomni-divider)]">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="welcome-recent-session-limit" className="text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      {t("settings.welcomeHistoryLimitLabel")}
                    </label>
                    <input
                      id="welcome-recent-session-limit"
                      data-testid="settings-welcome-recent-session-limit"
                      className="taomni-input h-8 w-full"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      aria-label={t("settings.welcomeHistoryLimitAria")}
                      value={welcomeRecentSessionLimit}
                      onChange={(e) => setWelcomeRecentSessionLimit(parseInt(e.target.value, 10))}
                    />
                  </div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)] flex items-center">
                    {t("settings.welcomeHistoryLimitHint")}
                  </div>
                </div>
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="global-ui">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <div className="mb-3 flex items-center gap-3">
                  <div>
                    <div className="text-[14px] font-semibold flex items-center gap-2">
                      <Type className="w-4 h-4 text-[var(--taomni-accent)]" />
                      {t("settings.globalUiTitle")}
                    </div>
                    <div className="text-[12px] text-[var(--taomni-text-muted)]">
                      {t("settings.globalUiSubtitle")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="taomni-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
                    onClick={() => {
                      setUiFontFamily('"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
                      setUiFontSize(12);
                    }}
                    title={t("settings.resetUiFontTitle")}
                  >
                    <Undo className="w-3.5 h-3.5" />
                    {t("settings.resetUiFont")}
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-2 border-t border-[var(--taomni-divider)]">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="ui-font-family-select" className="text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      {t("settings.fontFamilyLabel")}
                    </label>
                    <FontPickerSelect
                      ariaLabel={t("settings.fontFamilyLabel")}
                      id="ui-font-family-select"
                      testId="ui-font-family-select"
                      options={uiFontOptions}
                      selectedValue={currentSelectValue}
                      groupLabels={uiFontGroupLabels}
                      loading={fontCatalogRequested && systemFonts.loading}
                      onOpen={requestSystemFonts}
                      onSelect={setUiFontFamily}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center text-[12px] font-medium text-[var(--taomni-text-muted)]">
                      <label htmlFor="ui-font-size-slider">{t("settings.fontSizeLabel")}</label>
                      <span className="font-mono bg-[var(--taomni-selected)] text-[var(--taomni-accent)] px-1.5 py-0.5 rounded text-[11px] font-semibold">
                        {uiFontSize}px
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-[var(--taomni-text-muted)]">A</span>
                      <input
                        id="ui-font-size-slider"
                        type="range"
                        min="10"
                        max="18"
                        step="1"
                        value={uiFontSize}
                        onChange={(e) => setUiFontSize(parseInt(e.target.value, 10))}
                        className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer accent-[var(--taomni-accent)] bg-[var(--taomni-divider)]"
                      />
                      <span className="text-[14px] font-semibold text-[var(--taomni-text-muted)]">A</span>
                    </div>
                  </div>
                </div>
                <label className="mt-3 pt-2 border-t border-[var(--taomni-divider)] flex items-start gap-2 text-[12px] cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="settings-merge-tool-window-rail"
                    className="mt-0.5"
                    checked={mergeToolWindowRail}
                    onChange={(e) => setMergeToolWindowRail(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">{t("settings.mergeToolWindowRailLabel")}</span>
                    <span className="block text-[var(--taomni-text-muted)]">{t("settings.mergeToolWindowRailHint")}</span>
                  </span>
                </label>
              </section>
            </SettingsAnchor>
            <SettingsAnchor id="screenshot">
              <ScreenshotSettings />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Code —— */}
          <SettingsGroup
            id="code"
            title={groupTitle("settings.groupCode")}
            expanded={!!expandedGroups.code}
            onToggle={() => toggleGroup("code")}
            matchCount={matchCountByGroup.code ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="code-view-appearance">
              <div className="mb-4 flex items-center gap-3">
                <div>
                  <div className="text-[18px] font-semibold">{t("settings.codeViewAppearanceTitle")}</div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("settings.codeViewAppearanceSubtitle")}</div>
                </div>
                <button
                  data-testid="settings-reset-code-view-profile"
                  className="taomni-btn ml-auto h-8 inline-flex items-center gap-1.5"
                  type="button"
                  onClick={() => setCodeViewProfile(DEFAULT_CODE_VIEW_PROFILE)}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("settings.reset")}
                </button>
              </div>
              <CodeViewAppearanceSettings
                profile={codeViewProfile}
                terminalProfile={DEFAULT_TERMINAL_PROFILE}
                onProfileChange={setCodeViewProfile}
                fontState={systemFonts}
                onRequestSystemFonts={requestSystemFonts}
              />
            </SettingsAnchor>

            <SettingsAnchor id="sdks" className="mt-4">
              <SdkSettings />
            </SettingsAnchor>

            <SettingsAnchor id="language-servers" className="mt-4">
              <LanguageServersSettings />
            </SettingsAnchor>

            <SettingsAnchor id="live-templates" className="mt-4">
              <LiveTemplatesSettings />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Database —— */}
          <SettingsGroup
            id="database"
            title={groupTitle("settings.groupDatabase")}
            expanded={!!expandedGroups.database}
            onToggle={() => toggleGroup("database")}
            matchCount={matchCountByGroup.database ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="sql-completion">
              <SqlCompletionSettings />
            </SettingsAnchor>

            <SettingsAnchor id="sql-execution" className="mt-4">
              <SqlExecutionSettings />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Terminal —— */}
          <SettingsGroup
            id="terminal"
            title={groupTitle("settings.groupTerminal")}
            expanded={!!expandedGroups.terminal}
            onToggle={() => toggleGroup("terminal")}
            matchCount={matchCountByGroup.terminal ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="sftp">
              <SftpSettings />
            </SettingsAnchor>
            <SettingsAnchor id="terminal-defaults" className="mt-4">
              <div className="mb-4 flex items-center gap-3">
                <Terminal className="w-4 h-4 text-[var(--taomni-accent)]" />
                <div>
                  <div className="text-[18px] font-semibold">{t("settings.terminalDefaultsTitle")}</div>
                  <div className="text-[12px] text-[var(--taomni-text-muted)]">
                    {t("settings.terminalDefaultsSubtitle")}
                  </div>
                </div>
                <button
                  data-testid="settings-reset-terminal-default-profile"
                  className="taomni-btn ml-auto h-8 inline-flex items-center gap-1.5"
                  type="button"
                  onClick={resetTerminalDefaultProfile}
                  title={t("settings.resetTerminalDefaults")}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("settings.reset")}
                </button>
              </div>
              <TerminalAppearanceSettings
                profile={terminalDefaultProfile}
                onProfileChange={handleTerminalDefaultProfileChange}
                showCustomColors
                allowSystemTheme
                fontState={systemFonts}
                onRequestSystemFonts={requestSystemFonts}
              />
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Security —— */}
          <SettingsGroup
            id="security"
            title={groupTitle("settings.groupSecurity")}
            expanded={!!expandedGroups.security}
            onToggle={() => toggleGroup("security")}
            matchCount={matchCountByGroup.security ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="vault">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]">
                <VaultSettings />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Backup & Restore —— */}
          <SettingsGroup
            id="backup"
            title={groupTitle("settings.groupBackup")}
            expanded={!!expandedGroups.backup}
            onToggle={() => toggleGroup("backup")}
            matchCount={matchCountByGroup.backup ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="backup">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-4">
                <BackupSettingsPanel />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— Network —— */}
          <SettingsGroup
            id="network"
            title={groupTitle("settings.groupNetwork")}
            expanded={!!expandedGroups.network}
            onToggle={() => toggleGroup("network")}
            matchCount={matchCountByGroup.network ?? 0}
            searching={searching}
          >
            <SettingsAnchor id="app-proxy">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <AppProxyPanel />
              </section>
            </SettingsAnchor>

            <SettingsAnchor id="lanchat">
              <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
                <LanChatSettings />
              </section>
            </SettingsAnchor>
          </SettingsGroup>

          {/* —— AI —— */}
          <SettingsGroup
            id="ai"
            title={groupTitle("settings.groupAi")}
            expanded={!!expandedGroups.ai}
            onToggle={() => toggleGroup("ai")}
            matchCount={matchCountByGroup.ai ?? 0}
            searching={searching}
          >
            <section className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
              <SettingsAnchor id="ai-master">
                <div className="mb-3 flex items-center gap-2">
                  <Bot className="w-4 h-4 text-[var(--taomni-accent)]" />
                  <div>
                    <div className="text-[14px] font-semibold">{t("settings.aiSection")}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)]">
                      {t("settings.aiSubtitle")}
                    </div>
                  </div>
                </div>
                <div className="mb-3">
                  <AiMasterSwitch />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-privacy">
                <div className="mb-3">
                  <PrivacyToggle />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-shell">
                <div className="mb-3 pt-3 border-t border-[var(--taomni-divider)]">
                  <AiShellPanel enabled={voiceShellEnabled} onToggle={toggleVoiceShell} />
                </div>
              </SettingsAnchor>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-[var(--taomni-divider)]">
                <SettingsAnchor id="ai-asr">
                  <AsrPanel />
                </SettingsAnchor>
                <SettingsAnchor id="ai-llm">
                  <LlmProvidersPanel />
                </SettingsAnchor>
              </div>
              <SettingsAnchor id="ai-websearch">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <WebSearchPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-claude">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ClaudeCodePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-codex">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <CodexCodePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-acp">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <AcpAgentsPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chatformat">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatOutputFormatPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chatsend">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatSendShortcutPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-answerlang">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <EditorAiLanguagePanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-chathistory">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ChatHistoryPanel />
                </div>
              </SettingsAnchor>

              <SettingsAnchor id="ai-models">
                <div className="pt-3 border-t border-[var(--taomni-divider)]">
                  <ModelsAdvancedPanel />
                </div>
              </SettingsAnchor>
            </section>
          </SettingsGroup>
        </div>
      </div>
    </SettingsSearchContext.Provider>
  ));
}
