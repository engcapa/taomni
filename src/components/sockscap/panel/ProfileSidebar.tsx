import { ArrowDown, ArrowUp, Copy, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { type SocksCapConfig, type SocksCapProfile } from "../../../lib/sockscap";
import { MIN_PROFILE_PRIORITY, MAX_PROFILE_PRIORITY } from "./configuration";

export interface ProfileSidebarProps {
  sidebarWidth: number;
  t: import("../../../lib/i18n").TranslateFn;
  addProfile: () => Promise<void>;
  locked: boolean;
  setIsRibbon: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setShowSubImport: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showSubImport: boolean;
  subInput: string;
  setSubInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  onImportSubscription: () => Promise<void>;
  busy: boolean;
  priorityOrderedProfiles: import("./configuration").IndexedProfile[];
  cfg: SocksCapConfig;
  selectProfile: (id: string) => void;
  toggleProfileActive: (id: string) => Promise<void>;
  duplicateProfile: (prof: SocksCapProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  moveProfilePriority: (id: string, direction: -1 | 1) => Promise<void>;
  setProfilePriority: (id: string, value: number) => Promise<void>;
}

export function ProfileSidebar(viewProps: ProfileSidebarProps) {
  return (<div
    style={{ width: viewProps.sidebarWidth }}
    className="shrink-0 flex flex-col bg-[var(--taomni-panel-bg)] p-3 space-y-3 overflow-y-auto border-r border-[var(--taomni-divider)] select-none relative"
    data-testid="sockscap-profile-list"
  >
    <div className="flex items-center justify-between gap-1">
      <span className="text-[12px] font-bold text-[var(--taomni-text)] truncate">
        {viewProps.t("sockscap.profilesTitle")}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          data-testid="sockscap-add-profile"
          className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void viewProps.addProfile()}
          disabled={viewProps.locked}
          title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : viewProps.t("sockscap.newProfileTooltip")}
          aria-label={viewProps.t("sockscap.newProfileTooltip")}
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors flex items-center justify-center"
          onClick={() => viewProps.setIsRibbon(true)}
          title={viewProps.t("sockscap.collapseProfiles")}
          aria-label={viewProps.t("sockscap.collapseProfiles")}
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>
    </div>

    {/* Subscription import: paste a URL or blob → one profile per node. */}
    <div className="mb-1.5">
      <button
        type="button"
        data-testid="sockscap-sub-import-toggle"
        className="w-full text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => viewProps.setShowSubImport((v) => !v)}
        disabled={viewProps.locked}
        title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
      >
        {viewProps.t("sockscap.subImportToggle")}
      </button>
      {viewProps.showSubImport && (
        <div className="mt-1.5 space-y-1.5">
          <textarea
            data-testid="sockscap-sub-input"
            className="w-full text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] resize-y min-h-[48px]"
            placeholder={viewProps.t("sockscap.subImportPlaceholder")}
            value={viewProps.subInput}
            disabled={viewProps.locked}
            title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
            onChange={(e) => viewProps.setSubInput(e.target.value)}
          />
          <button
            type="button"
            data-testid="sockscap-sub-import"
            className="w-full text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void viewProps.onImportSubscription()}
            disabled={viewProps.busy || viewProps.locked || !viewProps.subInput.trim()}
          >
            {viewProps.t("sockscap.subImportBtn")}
          </button>
        </div>
      )}
    </div>

    <div className="space-y-1.5 flex-1 overflow-y-auto">
      {viewProps.priorityOrderedProfiles.map(({ profile: p }, priorityIndex) => {
        const isSelected = p.id === viewProps.cfg.selectedProfileId;
        const isActive = p.enabled && viewProps.cfg.activeProfileIds.includes(p.id);
        const priorityHint = viewProps.t("sockscap.priorityHint");
        return (
          <div
            key={p.id}
            data-testid={`sockscap-profile-item-${p.id}`}
            className={`p-2 rounded-lg border text-[11px] transition-all cursor-pointer ${isSelected
              ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/10 shadow-sm"
              : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] bg-[var(--taomni-bg)]"
              }`}
            onClick={() => viewProps.selectProfile(p.id)}
          >
            <div className="flex items-center justify-between gap-1.5 mb-1">
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <input
                  type="checkbox"
                  data-testid={`sockscap-profile-checkbox-${p.id}`}
                  checked={isActive}
                  disabled={viewProps.locked}
                  onChange={(e) => {
                    e.stopPropagation();
                    void viewProps.toggleProfileActive(p.id);
                  }}
                  className="rounded border-[var(--taomni-divider)] text-[var(--taomni-accent)] focus:ring-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title={
                    viewProps.locked
                      ? viewProps.t("sockscap.lockedTooltip")
                      : isActive
                        ? viewProps.t("sockscap.activeTooltipActive")
                        : viewProps.t("sockscap.activeTooltipInactive")
                  }
                />
                <span className="text-[13px]">{p.icon || "🛡️"}</span>
                <span className="font-semibold truncate">{p.name}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="p-1 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] rounded disabled:opacity-40 disabled:cursor-not-allowed"
                  title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : viewProps.t("sockscap.duplicateProfileTooltip")}
                  onClick={() => void viewProps.duplicateProfile(p)}
                  disabled={viewProps.locked}
                >
                  <Copy className="w-3 h-3" />
                </button>
                {viewProps.cfg.profiles.length > 1 && (
                  <button
                    type="button"
                    data-testid={`sockscap-delete-profile-${p.id}`}
                    className="p-1 text-[var(--taomni-text-muted)] hover:text-red-500 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                    title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : viewProps.t("sockscap.deleteProfileTooltip")}
                    onClick={() => void viewProps.deleteProfile(p.id)}
                    disabled={viewProps.locked}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] text-[var(--taomni-text-muted)]">
              <span>
                {p.mode === "global"
                  ? viewProps.t("sockscap.scopeGlobal")
                  : viewProps.t("sockscap.appsBound", { count: p.apps.length })}
              </span>
              <span className="px-1.5 py-0.2 rounded bg-[var(--taomni-hover)] font-mono">
                {p.ruleMode}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
              <span title={priorityHint}>{viewProps.t("sockscap.priorityLabel")}</span>
              <button
                type="button"
                data-testid={`sockscap-profile-priority-up-${p.id}`}
                className="p-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={viewProps.locked || priorityIndex === 0}
                title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : viewProps.t("sockscap.raisePriorityTooltip")}
                aria-label={viewProps.t("sockscap.raisePriorityTooltip")}
                onClick={(event) => {
                  event.stopPropagation();
                  void viewProps.moveProfilePriority(p.id, -1);
                }}
              >
                <ArrowUp className="w-3 h-3" />
              </button>
              <input
                type="number"
                step={1}
                min={MIN_PROFILE_PRIORITY}
                max={MAX_PROFILE_PRIORITY}
                data-testid={`sockscap-profile-priority-input-${p.id}`}
                className="w-12 px-1 py-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-center font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                value={p.priority}
                disabled={viewProps.locked}
                title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : priorityHint}
                aria-label={viewProps.t("sockscap.priorityInputLabel", { name: p.name })}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (!raw) return;
                  const value = Number(raw);
                  if (Number.isFinite(value)) {
                    void viewProps.setProfilePriority(p.id, value);
                  }
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.value.trim()) {
                    event.currentTarget.value = String(p.priority);
                  }
                }}
              />
              <button
                type="button"
                data-testid={`sockscap-profile-priority-down-${p.id}`}
                className="p-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={viewProps.locked || priorityIndex === viewProps.priorityOrderedProfiles.length - 1}
                title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : viewProps.t("sockscap.lowerPriorityTooltip")}
                aria-label={viewProps.t("sockscap.lowerPriorityTooltip")}
                onClick={(event) => {
                  event.stopPropagation();
                  void viewProps.moveProfilePriority(p.id, 1);
                }}
              >
                <ArrowDown className="w-3 h-3" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  </div>);
}
