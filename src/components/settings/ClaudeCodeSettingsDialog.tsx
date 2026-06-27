import { useEffect, useState, useRef } from "react";
import { Sliders, Loader2, X, Plus, Trash2, Shield, AlertTriangle } from "lucide-react";
import { useAiStore, CcCustomSettingsProfile } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  ccGetProfileSettings,
  vaultPut,
  vaultUpdate,
  vaultDelete,
  vaultStatus,
  isVaultLockedError,
  VAULT_LOCKED_EVENT,
} from "../../lib/ipc";

// Starter template for new profiles
const SETTINGS_TEMPLATE = `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-key",
    "ANTHROPIC_BASE_URL": "https://url"
  },
  "permissions": {
    "allow": [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "WebFetch",
      "Grep",
      "Glob",
      "LS"
    ],
    "defaultMode": "acceptEdits"
  }
}`;

interface ClaudeCodeSettingsDialogProps {
  onClose: () => void;
}

export function ClaudeCodeSettingsDialog({ onClose }: ClaudeCodeSettingsDialogProps) {
  const t = useT();
  const { config, saveConfig } = useAiStore();

  const [profiles, setProfiles] = useState<CcCustomSettingsProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>(undefined);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Contents dictionary (id -> json text)
  const [profileContents, setProfileContents] = useState<Record<string, string>>({});
  const [loadingContents, setLoadingContents] = useState<Record<string, boolean>>({});
  const [dirtyProfileIds, setDirtyProfileIds] = useState<Set<string>>(new Set());
  const [deletedProfileIds, setDeletedProfileIds] = useState<Set<string>>(new Set());

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const testSessionRef = useRef(0);

  // Reset test state on profile change
  useEffect(() => {
    testSessionRef.current += 1;
    setTestResult(null);
    setTestError(null);
    setTesting(false);

    // Kill the previous test process immediately when switching profiles
    void invoke("cc_stop_session", { threadId: "cc_test_settings_thread" }).catch(() => {});
  }, [selectedProfileId]);

  // Clean up test process on dialog unmount
  useEffect(() => {
    return () => {
      testSessionRef.current += 1;
      void invoke("cc_stop_session", { threadId: "cc_test_settings_thread" }).catch(() => {});
    };
  }, []);

  const handleTestSettings = async () => {
    if (!selectedContent) return;

    testSessionRef.current += 1;
    const currentSession = testSessionRef.current;

    setTesting(true);
    setTestResult("");
    setTestError(null);

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<any>("cc-test-settings-stream", (event) => {
        if (testSessionRef.current !== currentSession) return;
        const payload = event.payload;
        if (payload.kind === "token") {
          setTestResult((cur) => (cur ?? "") + payload.content);
        } else if (payload.kind === "end") {
          setTestResult(payload.content);
        } else if (payload.kind === "error") {
          setTestError(payload.message);
        }
      });

      await invoke("cc_test_settings", { settingsJson: selectedContent });
    } catch (err: any) {
      if (testSessionRef.current === currentSession) {
        setTestError(err?.message || String(err));
      }
    } finally {
      if (unlisten) {
        unlisten();
      }
      if (testSessionRef.current === currentSession) {
        setTesting(false);
      }
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Load on mount
  useEffect(() => {
    if (!config) return;
    const cc = config.cc_bridge;

    const initialProfiles = cc.custom_settings_profiles ? [...cc.custom_settings_profiles] : [];
    const initialActiveId = cc.active_profile_id;

    setProfiles(initialProfiles);
    setActiveProfileId(initialActiveId);

    if (initialProfiles.length > 0) {
      const toSelect = initialActiveId && initialProfiles.some(p => p.id === initialActiveId)
        ? initialActiveId
        : initialProfiles[0].id;
      setSelectedProfileId(toSelect);
    }
  }, [config]);

  // Load selected profile settings content from the vault if needed
  useEffect(() => {
    if (!selectedProfileId) return;

    // If we already have the content or it's a new profile (no vault_ref), skip
    if (profileContents[selectedProfileId] !== undefined) return;

    const profile = profiles.find(p => p.id === selectedProfileId);
    if (!profile || !profile.vault_ref) {
      // Brand new unsaved profile - default to template
      setProfileContents(prev => ({ ...prev, [selectedProfileId]: SETTINGS_TEMPLATE }));
      return;
    }

    let cancelled = false;
    const fetchContent = async () => {
      setLoadingContents(prev => ({ ...prev, [selectedProfileId]: true }));
      setError(null);
      try {
        const json = await ccGetProfileSettings(profile.vault_ref);
        if (cancelled) return;
        setProfileContents(prev => ({ ...prev, [selectedProfileId]: json ?? SETTINGS_TEMPLATE }));
      } catch (e) {
        if (cancelled) return;
        if (isVaultLockedError(e)) {
          onClose();
        } else {
          setError(String(e));
        }
      } finally {
        if (cancelled) return;
        setLoadingContents(prev => ({ ...prev, [selectedProfileId]: false }));
      }
    };

    void fetchContent();
    return () => {
      cancelled = true;
    };
  }, [selectedProfileId, profiles, profileContents]);

  // Sort profiles by creation time
  const sortedProfiles = [...profiles]
    .filter(p => !deletedProfileIds.has(p.id))
    .sort((a, b) => a.created_at - b.created_at);

  const selectedProfile = profiles.find(p => p.id === selectedProfileId);
  const selectedContent = selectedProfileId ? (profileContents[selectedProfileId] ?? "") : "";
  const isSelectedLoading = selectedProfileId ? !!loadingContents[selectedProfileId] : false;

  const handleAddProfile = () => {
    const newId = "profile_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
    const newProfile: CcCustomSettingsProfile = {
      id: newId,
      name: t("aiSettings.ccCustomNewProfileName") + ` ${profiles.length + 1}`,
      enabled: true,
      vault_ref: "", // will be generated upon save
      created_at: Date.now(),
    };

    setProfiles(prev => [...prev, newProfile]);
    setProfileContents(prev => ({ ...prev, [newId]: SETTINGS_TEMPLATE }));
    setDirtyProfileIds(prev => {
      const next = new Set(prev);
      next.add(newId);
      return next;
    });
    setSelectedProfileId(newId);

    // If no active profile, make this active
    if (!activeProfileId) {
      setActiveProfileId(newId);
    }
  };

  const handleDeleteProfile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const profile = profiles.find(p => p.id === id);
    if (!profile) return;

    if (!window.confirm(t("aiSettings.ccCustomConfirmDelete", { name: profile.name }))) {
      return;
    }

    setDeletedProfileIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    // Handle selection and active changes
    if (selectedProfileId === id) {
      const remaining = sortedProfiles.filter(p => p.id !== id);
      setSelectedProfileId(remaining.length > 0 ? remaining[0].id : null);
    }
    if (activeProfileId === id) {
      const remaining = sortedProfiles.filter(p => p.id !== id);
      setActiveProfileId(remaining.length > 0 ? remaining[0].id : undefined);
    }
  };

  const handleUpdateContent = (text: string) => {
    if (!selectedProfileId) return;
    setProfileContents(prev => ({ ...prev, [selectedProfileId]: text }));
    setDirtyProfileIds(prev => {
      const next = new Set(prev);
      next.add(selectedProfileId);
      return next;
    });
  };

  const handleUpdateName = (name: string) => {
    if (!selectedProfileId) return;
    setProfiles(prev => prev.map(p => p.id === selectedProfileId ? { ...p, name } : p));
  };

  const handleToggleEnabled = (enabled: boolean) => {
    if (!selectedProfileId) return;
    setProfiles(prev => prev.map(p => p.id === selectedProfileId ? { ...p, enabled } : p));
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);

    try {
      // 1. Ensure vault is unlocked
      const vstatus = await vaultStatus().catch(() => null);
      if (!vstatus || vstatus.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("aiSettings.ccCustomVaultRequired") },
          }),
        );
        setError(t("aiSettings.ccCustomVaultRequired"));
        setSaving(false);
        return;
      }

      // 2. Validate JSON configurations for all modified profiles
      const validatedContents: Record<string, string> = {};
      for (const id of dirtyProfileIds) {
        if (deletedProfileIds.has(id)) continue;
        const text = profileContents[id];
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error(t("aiSettings.ccCustomNotObject"));
          }
          validatedContents[id] = JSON.stringify(parsed, null, 2);
        } catch (e) {
          const prof = profiles.find(p => p.id === id);
          setError(
            `${prof ? `[${prof.name}] ` : ""}${t("aiSettings.ccCustomInvalidJson", {
              error: (e as Error).message,
            })}`
          );
          setSaving(false);
          return;
        }
      }

      // 3. Delete deleted profile vault entries
      for (const id of deletedProfileIds) {
        const profile = profiles.find(p => p.id === id);
        if (profile && profile.vault_ref.startsWith("vault:")) {
          try {
            await vaultDelete(profile.vault_ref.substring("vault:".length));
          } catch {
            // Ignore if already deleted
          }
        }
      }

      // 4. Save/Update vault entries for dirty profiles
      const updatedProfiles: CcCustomSettingsProfile[] = [];
      for (const p of profiles) {
        if (deletedProfileIds.has(p.id)) continue;

        let vaultRef = p.vault_ref;
        if (dirtyProfileIds.has(p.id)) {
          const jsonText = validatedContents[p.id];
          if (vaultRef.startsWith("vault:")) {
            await vaultUpdate(vaultRef.substring("vault:".length), jsonText);
          } else {
            const res = await vaultPut(
              "cc_bridge:settings",
              `Claude Code settings.json (${p.name})`,
              jsonText
            );
            vaultRef = res.reference;
          }
        }

        updatedProfiles.push({
          ...p,
          vault_ref: vaultRef,
        });
      }

      // 5. Update global config store
      await saveConfig({
        ...config,
        cc_bridge: {
          ...config.cc_bridge,
          custom_settings_profiles: updatedProfiles,
          active_profile_id: activeProfileId,
        },
      });

      onClose();
    } catch (e) {
      if (!isVaultLockedError(e)) {
        setError(String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{
          width: "min(860px, 96vw)",
          height: "min(640px, 85vh)",
          minWidth: "min(640px, 96vw)",
          minHeight: "min(420px, 85vh)",
          maxWidth: "96vw",
          maxHeight: "85vh",
          resize: "both",
          background: "var(--taomni-panel-bg)",
          borderColor: "var(--taomni-chrome-border)",
          color: "var(--taomni-text)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Titlebar */}
        <div
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{
            background: "linear-gradient(to bottom, #5895c8, #2b5d8b)",
            color: "white",
          }}
        >
          <Sliders className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">{t("aiSettings.ccCustomModalTitle")}</div>
          <button
            title={t("common.close")}
            className="ml-auto hover:bg-red-500 rounded p-0.5"
            onClick={onClose}
            type="button"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body columns */}
        <div
          className="flex-1 min-h-0 flex border-x border-b overflow-hidden"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}
        >
          {/* Sidebar */}
          <div
            className="w-[240px] border-r flex flex-col shrink-0"
            style={{
              borderColor: "var(--taomni-divider)",
              background: "var(--taomni-panel-bg)",
            }}
          >
            <div className="p-2 border-b text-[11px] font-semibold" style={{ borderColor: "var(--taomni-divider)" }}>
              {t("aiSettings.ccCustomListHeader")}
            </div>

            <div className="flex-1 overflow-auto p-1.5 space-y-1">
              {sortedProfiles.map((p) => {
                const isActive = activeProfileId === p.id;
                const isSelected = selectedProfileId === p.id;
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center justify-between p-2 rounded cursor-pointer transition-colors text-[11px] ${
                      isSelected
                        ? "bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] font-medium"
                        : "hover:bg-[var(--taomni-hover)]"
                    }`}
                    onClick={() => setSelectedProfileId(p.id)}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className="truncate">{p.name}</span>
                      {isActive && (
                        <span className="px-1 text-[8px] leading-tight bg-green-500/15 text-green-400 border border-green-500/35 rounded shrink-0">
                          {t("aiSettings.ccCustomActiveLabel")}
                        </span>
                      )}
                      {!p.enabled && (
                        <span className="px-1 text-[8px] leading-tight bg-[var(--taomni-divider)] text-[var(--taomni-text-muted)] border rounded shrink-0">
                          {t("aiSettings.ccCustomDisabled")}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      title={t("common.delete")}
                      className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-0.5 transition-opacity rounded"
                      onClick={(e) => handleDeleteProfile(p.id, e)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="p-2 border-t" style={{ borderColor: "var(--taomni-divider)" }}>
              <button
                type="button"
                className="taomni-btn w-full h-7 px-3 text-[11px] inline-flex items-center justify-center gap-1"
                onClick={handleAddProfile}
              >
                <Plus className="w-3.5 h-3.5" />
                {t("aiSettings.ccCustomAddProfile")}
              </button>
            </div>
          </div>

          {/* Details Pane */}
          <div className="flex-1 overflow-auto p-4 flex flex-col min-w-0">
            {selectedProfile ? (
              <div className="flex-1 flex flex-col gap-3 min-h-0">
                {/* Profile fields */}
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">
                      {t("aiSettings.ccCustomProfileNameLabel")}
                    </label>
                    <input
                      type="text"
                      className="taomni-input h-7 w-full text-[12px]"
                      value={selectedProfile.name}
                      onChange={(e) => handleUpdateName(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        className="taomni-checkbox"
                        checked={activeProfileId === selectedProfile.id}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setActiveProfileId(selectedProfile.id);
                          }
                        }}
                      />
                      <span>{t("aiSettings.ccCustomActiveLabel")}</span>
                    </label>

                    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        className="taomni-checkbox"
                        checked={selectedProfile.enabled}
                        onChange={(e) => handleToggleEnabled(e.target.checked)}
                      />
                      <span>{t("aiSettings.ccCustomToggleEnable")}</span>
                    </label>
                  </div>
                </div>

                {/* JSON Textarea Editor */}
                <div className="flex-1 flex flex-col min-h-[220px] mt-2 relative">
                  <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">
                    settings.json
                  </label>
                  {isSelectedLoading ? (
                    <div className="flex-1 flex items-center justify-center border rounded" style={{ borderColor: "var(--taomni-input-border)" }}>
                      <Loader2 className="w-6 h-6 animate-spin text-[var(--taomni-text-muted)]" />
                    </div>
                  ) : (
                    <textarea
                      className="taomni-input flex-1 font-mono text-[11px] leading-relaxed w-full resize-none"
                      spellCheck={false}
                      value={selectedContent}
                      onChange={(e) => handleUpdateContent(e.target.value)}
                      placeholder={t("aiSettings.ccCustomPlaceholder")}
                    />
                  )}
                </div>

                {/* Test Section */}
                <div className="border border-[var(--taomni-divider)] rounded p-2 bg-[var(--taomni-panel-bg)]/50 flex flex-col gap-1.5 shrink-0 mt-1">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold text-[var(--taomni-text)]">
                      {t("aiSettings.ccTestTitle") || "Test Configuration"}
                    </div>
                    <button
                      type="button"
                      className="taomni-btn h-6 px-2 text-[10px]"
                      onClick={handleTestSettings}
                      disabled={testing || isSelectedLoading}
                    >
                      {testing ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin mr-1 inline" />
                          {t("aiSettings.ccTesting") || "Testing..."}
                        </>
                      ) : (
                        t("aiSettings.ccTestBtn") || "Run Test"
                      )}
                    </button>
                  </div>
                  
                  {/* Test Output Console */}
                  {(testResult !== null || testError !== null || testing) && (
                    <div className="bg-[var(--taomni-bg)] border border-[var(--taomni-input-border)] rounded p-1.5 text-[10px] font-mono max-h-[100px] overflow-y-auto leading-relaxed relative">
                      <div className="text-[9px] text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)] pb-0.5 mb-1">
                        Prompt: "Hello, My name is Taomni, Can you help me?"
                      </div>
                      {testing && !testResult && (
                        <div className="text-[var(--taomni-text-muted)] flex items-center gap-1">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          <span>Spawning Claude Code process and running test turn...</span>
                        </div>
                      )}
                      {testResult && (
                        <div className="whitespace-pre-wrap text-[var(--taomni-text)]">
                          {testResult}
                        </div>
                      )}
                      {testError && (
                        <div className="text-red-400 whitespace-pre-wrap">
                          Error: {testError}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="text-[10px] text-[var(--taomni-text-muted)] flex items-center gap-1 shrink-0">
                  <Shield className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("aiSettings.ccCustomNote")}</span>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--taomni-text-muted)] gap-2">
                <Sliders className="w-8 h-8 opacity-40" />
                <span className="text-[11px]">{t("aiSettings.ccCustomPlaceholder")}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="h-10 px-3 flex items-center gap-2 border-t shrink-0"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
        >
          {error && (
            <span className="text-[11px] text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[400px]">{error}</span>
            </span>
          )}

          <div className="flex-1" />

          <button
            className="taomni-btn"
            onClick={onClose}
            disabled={saving}
            type="button"
          >
            {t("common.cancel")}
          </button>
          <button
            className="taomni-btn"
            data-primary="true"
            onClick={handleSave}
            disabled={saving}
            type="button"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1 inline" /> : null}
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
