import { AlertCircle, CheckCircle2, Copy, Info, Loader2, PanelLeftOpen, Plus, RefreshCw, Shield } from "lucide-react";
import { type AppSelector, type ProcessInfo, type SocksCapConfig, type TargetTestResult, type UserRule } from "../../../lib/sockscap";
import { type UpstreamConfigIssue } from "../../../lib/sockscapPreflight";
import { type UpstreamChoice } from "../UpstreamSourcePicker";
import { useT } from "../../../lib/i18n";
import { Field } from "./Field";
import { Section } from "./Section";
import { SocksCapHeader } from "./SocksCapHeader";
import { ProfileSidebar } from "./ProfileSidebar";
import { ApplicationsSection } from "./ApplicationsSection";
import { UpstreamSection } from "./UpstreamSection";
import { RulesSection } from "./RulesSection";
import { TrafficSection } from "./TrafficSection";
import { useRootlessApplicationDraft } from "./useRootlessApplicationDraft";
import { useSocksCapRuntime } from "./useSocksCapRuntime";
import { SocksCapDialogs } from "./SocksCapDialogs";

export interface SocksCapViewProps {
  t: ReturnType<typeof useT>;
  runtime: ReturnType<typeof useSocksCapRuntime>;
  activeProfiles: import("../../../lib/sockscap").SocksCapProfile[];
  running: boolean;
  locked: boolean;
  linuxLaunchOnly: boolean;
  busy: boolean;
  onStop: () => Promise<void>;
  startButtonRef: import("react").RefObject<HTMLButtonElement | null>;
  preflightAndStart: (configOverride?: SocksCapConfig) => Promise<boolean>;
  probing: boolean;
  redirectorApprovalWaiting: boolean;
  onRefreshStatus: () => Promise<void>;
  onRecover: (sudoPassword?: string) => Promise<void>;
  onClose: (() => void) | undefined;
  copyDiagnostics: () => Promise<void>;
  refreshRedirectorApproval: () => Promise<void>;
  installRedirector: () => Promise<void>;
  isRibbon: boolean;
  setIsRibbon: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  addProfile: () => Promise<void>;
  priorityOrderedProfiles: import("./configuration").IndexedProfile[];
  selectProfile: (id: string) => void;
  sidebarWidth: number;
  setShowSubImport: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showSubImport: boolean;
  subInput: string;
  setSubInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  onImportSubscription: () => Promise<void>;
  toggleProfileActive: (id: string) => Promise<void>;
  duplicateProfile: (prof: import("../../../lib/sockscap").SocksCapProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  moveProfilePriority: (id: string, direction: -1 | 1) => Promise<void>;
  setProfilePriority: (id: string, value: number) => Promise<void>;
  handleMouseDownSplitter: (e: React.MouseEvent) => void;
  selectedProf: import("../../../lib/sockscap").SocksCapProfile;
  patchSelectedProfile: (partial: Partial<import("../../../lib/sockscap").SocksCapProfile>) => Promise<SocksCapConfig | null>;
  rootlessDraft: ReturnType<typeof useRootlessApplicationDraft>;
  addRootlessApplication: () => Promise<void>;
  pickMacosApplication: () => Promise<void>;
  pickLinuxApplication: () => Promise<void>;
  loadProcesses: () => Promise<void>;
  addAppPath: (path: string, name?: string) => Promise<{ app: AppSelector; config: SocksCapConfig; } | null>;
  stoppingPid: number | null;
  launchingPath: string | null;
  onStopLaunchedApp: (pid: number) => Promise<void>;
  onRootlessLaunchApp: (profileId: string, path: string, args?: string[], launchMode?: "desktop" | "terminal", launchPreparation?: import("../../../lib/sockscap").LaunchPreparation, name?: string, configOverride?: SocksCapConfig) => Promise<void>;
  shareLink: string;
  setShareLink: import("react").Dispatch<import("react").SetStateAction<string>>;
  onImportShareLink: () => Promise<void>;
  onSelectUpstreamSource: (choice: UpstreamChoice) => void;
  password: string;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  storePassword: () => Promise<void>;
  storingPass: boolean;
  clearPassword: () => Promise<void>;
  renderCoreParams: () => import("react").JSX.Element | null;
  onTestUpstream: () => Promise<void>;
  testing: boolean;
  newRule: UserRule;
  setNewRule: import("react").Dispatch<import("react").SetStateAction<UserRule>>;
  addUserRule: () => Promise<void>;
  testHost: string;
  setTestHost: import("react").Dispatch<import("react").SetStateAction<string>>;
  onTestTarget: () => Promise<void>;
  testResult: TargetTestResult | null;
  onRefreshGfw: () => Promise<void>;
  onImportGfw: () => Promise<void>;
  persistConfig: (next: SocksCapConfig) => Promise<boolean>;
  domainsExpanded: boolean;
  setDomainsExpanded: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  domainFilter: string;
  setDomainFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
  decisionFilter: "direct" | "proxy" | "block" | "all";
  setDecisionFilter: import("react").Dispatch<import("react").SetStateAction<"direct" | "proxy" | "block" | "all">>;
  topNLimit: number;
  setTopNLimit: import("react").Dispatch<import("react").SetStateAction<number>>;
  filteredDomainRecords: import("../../../lib/sockscap").DomainRecord[];
  msg: { ok: boolean; text: string; } | null;
  continueMacosSetupToStart: () => void;
  showProcPicker: boolean;
  setShowProcPicker: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  processes: ProcessInfo[];
  rootPromptIntent: "start" | "recover" | null;
  onStart: (sudoPassword?: string, configOverride?: SocksCapConfig) => Promise<boolean>;
  setRootPromptIntent: import("react").Dispatch<import("react").SetStateAction<"start" | "recover" | null>>;
  setRootPromptError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  rootPromptError: string | null;
  rootPromptBusy: boolean;
  configIssues: UpstreamConfigIssue[] | null;
  setConfigIssues: import("react").Dispatch<import("react").SetStateAction<UpstreamConfigIssue[] | null>>;
  probeFailures: { profileName: string; kind: string; error: string; }[] | null;
  setProbeFailures: import("react").Dispatch<import("react").SetStateAction<{ profileName: string; kind: string; error: string; }[] | null>>;
  testDetail: { title: string; body: string; } | null;
  setTestDetail: import("react").Dispatch<import("react").SetStateAction<{ title: string; body: string; } | null>>;
  copyTestDetail: () => Promise<void>;
  testCopied: boolean;
}

export function SocksCapView(props: SocksCapViewProps) {
  const {
    t,
    runtime,
    activeProfiles,
    running,
    locked,
    linuxLaunchOnly,
    busy,
    onStop,
    startButtonRef,
    preflightAndStart,
    probing,
    redirectorApprovalWaiting,
    onRefreshStatus,
    onRecover,
    onClose,
    copyDiagnostics,
    refreshRedirectorApproval,
    installRedirector,
    isRibbon,
    setIsRibbon,
    addProfile,
    priorityOrderedProfiles,
    selectProfile,
    sidebarWidth,
    setShowSubImport,
    showSubImport,
    subInput,
    setSubInput,
    onImportSubscription,
    toggleProfileActive,
    duplicateProfile,
    deleteProfile,
    moveProfilePriority,
    setProfilePriority,
    handleMouseDownSplitter,
    selectedProf,
    patchSelectedProfile,
    rootlessDraft,
    addRootlessApplication,
    pickMacosApplication,
    pickLinuxApplication,
    loadProcesses,
    addAppPath,
    stoppingPid,
    launchingPath,
    onStopLaunchedApp,
    onRootlessLaunchApp,
    shareLink,
    setShareLink,
    onImportShareLink,
    onSelectUpstreamSource,
    password,
    setPassword,
    storePassword,
    storingPass,
    clearPassword,
    renderCoreParams,
    onTestUpstream,
    testing,
    newRule,
    setNewRule,
    addUserRule,
    testHost,
    setTestHost,
    onTestTarget,
    testResult,
    onRefreshGfw,
    onImportGfw,
    persistConfig,
    domainsExpanded,
    setDomainsExpanded,
    domainFilter,
    setDomainFilter,
    decisionFilter,
    setDecisionFilter,
    topNLimit,
    setTopNLimit,
    filteredDomainRecords,
    msg,
    continueMacosSetupToStart,
    showProcPicker,
    setShowProcPicker,
    processes,
    rootPromptIntent,
    onStart,
    setRootPromptIntent,
    setRootPromptError,
    rootPromptError,
    rootPromptBusy,
    configIssues,
    setConfigIssues,
    probeFailures,
    setProbeFailures,
    testDetail,
    setTestDetail,
    copyTestDetail,
    testCopied,
  } = props;
  const { cfg, caps } = runtime;
  if (!cfg) return null;
  return ((
    <div
      className="sockscap-panel relative h-full flex flex-col bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)]"
      data-testid="sockscap-panel"
    >
      {/* Header */}
      <SocksCapHeader
        t={t}
        caps={caps}
        activeProfiles={activeProfiles}
        stats={runtime.stats}
        helper={runtime.helper}
        running={running}
        upSpeed={runtime.upSpeed}
        downSpeed={runtime.downSpeed}
        locked={locked}
        linuxLaunchOnly={linuxLaunchOnly}
        tunConflicts={runtime.tunConflicts}
        setTunWarningOpen={runtime.setTunWarningOpen}
        status={runtime.status}
        busy={busy}
        onStop={onStop}
        startButtonRef={startButtonRef}
        preflightAndStart={preflightAndStart}
        probing={probing}
        redirectorApprovalWaiting={redirectorApprovalWaiting}
        setMacosSetupError={runtime.setMacosSetupError}
        setMacosSetupGuideMode={runtime.setMacosSetupGuideMode}
        onRefreshStatus={onRefreshStatus}
        onRecover={onRecover}
        onClose={onClose}
      />

      {runtime.status?.phase === "recoveryRequired" && caps?.platform === "macos" && (
        <div className="px-4 py-3 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-700 dark:text-red-300">
          <div className="font-semibold">{t("sockscap.manualRecoveryTitle")}</div>
          <div className="mt-1">{runtime.status.message}</div>
          <ol className="mt-2 ml-4 list-decimal space-y-1">
            <li>{t("sockscap.manualRecoveryStep1")}</li>
            <li>{t("sockscap.manualRecoveryStep2")}</li>
            <li>{t("sockscap.manualRecoveryStep3")}</li>
          </ol>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/40 hover:bg-red-500/10"
            onClick={() => void copyDiagnostics()}
          >
            <Copy className="w-3 h-3" />
            {t("sockscap.copyDiagnostics")}
          </button>
        </div>
      )}

      {caps?.platform === "macos" && runtime.redirectorInstall?.state !== "ready" && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] flex flex-wrap items-center justify-between gap-2 text-amber-800 dark:text-amber-300">
          <span>{runtime.redirectorInstall?.message || t("sockscap.redirectorMissing")}</span>
          <button
            type="button"
            data-testid="sockscap-redirector-action"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50"
            disabled={
              busy ||
              (runtime.redirectorInstall?.state !== "pendingSystemApproval" &&
                (!runtime.redirectorInstall?.resourceAvailable ||
                  runtime.redirectorInstall?.state === "conflict"))
            }
            onClick={() =>
              void (runtime.redirectorInstall?.state === "pendingSystemApproval"
                ? refreshRedirectorApproval()
                : installRedirector())
            }
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : runtime.redirectorInstall?.state === "pendingSystemApproval" ? (
              <RefreshCw className="w-3 h-3" />
            ) : (
              <Shield className="w-3 h-3" />
            )}
            {runtime.redirectorInstall?.state === "pendingSystemApproval"
              ? t("sockscap.refreshRedirectorApproval")
              : t("sockscap.installRedirector")}
          </button>
        </div>
      )}

      {linuxLaunchOnly && (
        <div
          data-testid="sockscap-launch-only-banner"
          className="px-4 py-2 bg-sky-500/10 border-b border-sky-500/30 text-[11px] text-sky-800 dark:text-sky-300"
          title={caps?.linux?.transparentUnavailableReason || undefined}
        >
          <div className="flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">
                {t("sockscap.launchOnlyTitle")}
              </div>
              <div>{t("sockscap.launchOnlyDescription")}</div>
              {caps?.linux?.containerized && (
                <div className="mt-0.5">{t("sockscap.launchOnlyContainer")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Dual-Column Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left Column: Profile Manager Sidebar */}
        {!linuxLaunchOnly &&
          (isRibbon ? (
            <div
              className="w-[52px] shrink-0 flex flex-col items-center bg-[var(--taomni-panel-bg)] py-3 px-1 space-y-3 border-r border-[var(--taomni-divider)] select-none"
              data-testid="sockscap-profile-list"
            >
              <div className="flex flex-col items-center gap-1 shrink-0 pb-2 border-b border-[var(--taomni-divider)] w-full">
                <button
                  type="button"
                  className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors"
                  onClick={() => setIsRibbon(false)}
                  title={t("sockscap.expandProfiles")}
                  aria-label={t("sockscap.expandProfiles")}
                >
                  <PanelLeftOpen className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  data-testid="sockscap-add-profile"
                  className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => void addProfile()}
                  disabled={locked}
                  title={locked ? t("sockscap.lockedTooltip") : t("sockscap.newProfileTooltip")}
                  aria-label={t("sockscap.newProfileTooltip")}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 flex-1 overflow-y-auto w-full flex flex-col items-center">
                {priorityOrderedProfiles.map(({ profile: p }) => {
                  const isSelected = p.id === cfg.selectedProfileId;
                  const isActive = p.enabled && cfg.activeProfileIds.includes(p.id);
                  return (
                    <div
                      key={p.id}
                      data-testid={`sockscap-profile-item-${p.id}`}
                      className={`w-9 h-9 rounded-lg border flex items-center justify-center relative cursor-pointer transition-all ${isSelected
                        ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20 shadow-sm"
                        : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] bg-[var(--taomni-bg)]"
                        }`}
                      onClick={() => selectProfile(p.id)}
                      onDoubleClick={() => setIsRibbon(false)}
                      title={`${p.name} - ${p.mode === "global" ? t("sockscap.scopeGlobal") : t("sockscap.appsBound", { count: p.apps.length })} (${isActive ? t("sockscap.activeTooltipActive") : t("sockscap.activeTooltipInactive")})`}
                    >
                      <span className="text-base select-none">{p.icon || "🛡️"}</span>
                      {isActive && (
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 absolute -top-0.5 -right-0.5 ring-2 ring-[var(--taomni-panel-bg)]" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <ProfileSidebar
              sidebarWidth={sidebarWidth}
              t={t}
              addProfile={addProfile}
              locked={locked}
              setIsRibbon={setIsRibbon}
              setShowSubImport={setShowSubImport}
              showSubImport={showSubImport}
              subInput={subInput}
              setSubInput={setSubInput}
              onImportSubscription={onImportSubscription}
              busy={busy}
              priorityOrderedProfiles={priorityOrderedProfiles}
              cfg={cfg}
              selectProfile={selectProfile}
              toggleProfileActive={toggleProfileActive}
              duplicateProfile={duplicateProfile}
              deleteProfile={deleteProfile}
              moveProfilePriority={moveProfilePriority}
              setProfilePriority={setProfilePriority}
            />
          ))}

        {/* Resizable Handle / Splitter */}
        {!linuxLaunchOnly && !isRibbon && (
          <div
            className="w-1 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/40 active:bg-[var(--taomni-accent)] transition-colors shrink-0 z-10 self-stretch"
            onMouseDown={handleMouseDownSplitter}
            title="Drag to resize panel"
          />
        )}

        {/* Right Column: Selected Profile Detail & Inspector */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {linuxLaunchOnly && (
            <section
              data-testid="sockscap-rootless-mode"
              className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3"
            >
              <div className="text-[13px] font-semibold">
                {t("sockscap.rootlessModeTitle")}
              </div>
              <p className="mt-1 text-[11px] leading-5 text-[var(--taomni-text-muted)]">
                {t("sockscap.rootlessModeDescription")}
              </p>
              {caps?.linux?.containerized && (
                <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-300">
                  {t("sockscap.launchOnlyContainer")}
                </p>
              )}
            </section>
          )}

          {/* Profile Basic info header */}
          {!linuxLaunchOnly && (
            <Section sectionId="profile" title={t("sockscap.editProfileTitle", { name: selectedProf.name })}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={t("sockscap.profileNameLabel")}>
                  <input
                    className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                    value={selectedProf.name}
                    disabled={locked}
                    title={locked ? t("sockscap.lockedTooltip") : undefined}
                    onChange={(e) => void patchSelectedProfile({ name: e.target.value })}
                  />
                </Field>
                <Field label={t("sockscap.profileIconLabel")}>
                  <div className="flex gap-1.5">
                    {["🎮", "💻", "🎬", "🌐", "⚡", "🛡️"].map((ic) => (
                      <button
                        key={ic}
                        type="button"
                        disabled={locked}
                        title={locked ? t("sockscap.lockedTooltip") : undefined}
                        className={`px-2 py-1 rounded text-[13px] border disabled:opacity-50 disabled:cursor-not-allowed ${selectedProf.icon === ic
                          ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20"
                          : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                          }`}
                        onClick={() => void patchSelectedProfile({ icon: ic })}
                      >
                        {ic}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            </Section>
          )}

          {/* Scope Mode */}
          <ApplicationsSection
            draft={rootlessDraft}
            linuxLaunchOnly={linuxLaunchOnly}
            t={t}
            caps={caps}
            locked={locked}
            selectedProf={selectedProf}
            patchSelectedProfile={patchSelectedProfile}

            addRootlessApplication={addRootlessApplication}

            pickMacosApplication={pickMacosApplication}
            pickLinuxApplication={pickLinuxApplication}
            loadProcesses={loadProcesses}
            addAppPath={addAppPath}
            launchedApps={runtime.launchedApps}
            cfg={cfg}
            stoppingPid={stoppingPid}
            launchingPath={launchingPath}
            onStopLaunchedApp={onStopLaunchedApp}
            running={running}
            busy={busy}
            probing={probing}
            onRootlessLaunchApp={onRootlessLaunchApp}

          />

          {/* Upstream */}
          <UpstreamSection
            t={t}
            linuxLaunchOnly={linuxLaunchOnly}
            detectedProxies={runtime.detectedProxies}
            selectedProf={selectedProf}
            locked={locked}
            patchSelectedProfile={patchSelectedProfile}
            shareLink={shareLink}
            setShareLink={setShareLink}
            onImportShareLink={onImportShareLink}
            busy={busy}
            sessions={runtime.sessions}
            onSelectUpstreamSource={onSelectUpstreamSource}
            rescanLocalProxies={runtime.rescanLocalProxies}
            password={password}
            setPassword={setPassword}
            storePassword={storePassword}
            storingPass={storingPass}
            clearPassword={clearPassword}
            renderCoreParams={renderCoreParams}
            onTestUpstream={onTestUpstream}
            testing={testing}
          />

          {/* Rules Strategy */}
          <RulesSection
            t={t}
            linuxLaunchOnly={linuxLaunchOnly}
            locked={locked}
            selectedProf={selectedProf}
            patchSelectedProfile={patchSelectedProfile}
            newRule={newRule}
            setNewRule={setNewRule}
            addUserRule={addUserRule}
          />

          {/* Test Target Dry-run */}
          {!linuxLaunchOnly && (
            <Section sectionId="test" title={t("sockscap.section.test")}>
              <div className="flex gap-2 items-center">
                <input
                  data-testid="sockscap-test-host"
                  className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  value={testHost}
                  onChange={(e) => setTestHost(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="sockscap-test-target"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => void onTestTarget()}
                  disabled={busy || testing}
                >
                  {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {testing ? t("sockscap.testing") : t("sockscap.testTarget")}
                </button>
              </div>
              {testResult && (
                <div className="mt-2 p-2 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)] text-[11px]">
                  <span className="font-semibold">{testResult.host}: </span>
                  <span className="uppercase font-medium text-[var(--taomni-accent)]">
                    {testResult.decision}
                  </span>{" "}
                  · {testResult.reason}
                </div>
              )}
            </Section>
          )}

          {/* Global GFWList & Shared Controls */}
          <Section
            sectionId="gfwlist"
            title={t("sockscap.gfwListTitle")}
            defaultExpanded={linuxLaunchOnly}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                {runtime.gfw?.loaded
                  ? t("sockscap.gfwStatus", {
                    count: String(runtime.gfw.ruleCount),
                    skipped: String(runtime.gfw.skipped),
                    when: runtime.gfw.lastRefresh
                      ? new Date(runtime.gfw.lastRefresh).toLocaleString()
                      : t("common.justNow"),
                  })
                  : t("sockscap.gfwNotLoaded")}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="sockscap-refresh-gfw"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => void onRefreshGfw()}
                  disabled={busy || locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                >
                  <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
                  {t("sockscap.refreshGfw")}
                </button>
                <button
                  type="button"
                  data-testid="sockscap-import-gfw"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => void onImportGfw()}
                  disabled={busy || locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                >
                  {t("sockscap.importGfw")}
                </button>
              </div>
            </div>

            {/* Session-level QUIC blocking (forces QUIC→TCP so capture can proxy it). */}
            <label
              className="mt-3 flex items-start gap-2 text-[12px] cursor-pointer select-none"
              title={locked ? t("sockscap.lockedTooltip") : undefined}
            >
              <input
                type="checkbox"
                data-testid="sockscap-block-quic"
                checked={cfg.blockQuic ?? true}
                disabled={locked || busy}
                onChange={(e) => {
                  if (!cfg) return;
                  void persistConfig({ ...cfg, blockQuic: e.target.checked });
                }}
                className="mt-0.5 rounded border-[var(--taomni-divider)] text-[var(--taomni-accent)] focus:ring-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="flex-1">
                <span className="font-medium text-[var(--taomni-text)]">
                  {t("sockscap.blockQuic")}
                </span>
                <span className="block text-[11px] text-[var(--taomni-text-muted)]">
                  {t("sockscap.blockQuicHint")}
                </span>
              </span>
            </label>
          </Section>

          {/* Captured Domains & Traffic Table */}
          <TrafficSection
            domainsExpanded={domainsExpanded}
            setDomainsExpanded={setDomainsExpanded}
            domainRecords={runtime.domainRecords}
            domainFilter={domainFilter}
            setDomainFilter={setDomainFilter}
            decisionFilter={decisionFilter}
            setDecisionFilter={setDecisionFilter}
            topNLimit={topNLimit}
            setTopNLimit={setTopNLimit}
            setDomainRecords={runtime.setDomainRecords}
            filteredDomainRecords={filteredDomainRecords}
            locked={locked}
            t={t}
            cfg={cfg}
            selectedProf={selectedProf}
            patchSelectedProfile={patchSelectedProfile}
          />

          {msg && (
            <div
              className={`mt-2 text-[11px] flex gap-1 items-start ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"
                }`}
            >
              {msg.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              {msg.text}
            </div>
          )}
        </div>
      </div>

      <SocksCapDialogs
        runtime={runtime}
        busy={busy}
        installRedirector={installRedirector}
        refreshRedirectorApproval={refreshRedirectorApproval}
        continueMacosSetupToStart={continueMacosSetupToStart}
        showProcPicker={showProcPicker}
        t={t}
        setShowProcPicker={setShowProcPicker}
        processes={processes}
        addAppPath={addAppPath}
        rootPromptIntent={rootPromptIntent}
        onRecover={onRecover}
        onStart={onStart}
        setRootPromptIntent={setRootPromptIntent}
        setRootPromptError={setRootPromptError}
        rootPromptError={rootPromptError}
        rootPromptBusy={rootPromptBusy}
        configIssues={configIssues}
        setConfigIssues={setConfigIssues}
        probeFailures={probeFailures}
        setProbeFailures={setProbeFailures}
        testDetail={testDetail}
        setTestDetail={setTestDetail}
        copyTestDetail={copyTestDetail}
        testCopied={testCopied}
      /></div>
  ));
}
