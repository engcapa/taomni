import { sockscapSetConfig, sockscapImportSubscription, type SocksCapConfig, type SocksCapProfile, type UpstreamKind, type UpstreamParams } from "../../../lib/sockscap";
import { vaultPut, vaultStatus, VAULT_LOCKED_EVENT } from "../../../lib/ipc";
import { MIN_PROFILE_PRIORITY, MAX_PROFILE_PRIORITY } from "./configuration";


export interface CreateProfileActionsContext {
  locked: boolean;
  report: (text: string, ok?: boolean) => void;
  t: import("../../../lib/i18n").TranslateFn;
  setCfg: import("react").Dispatch<import("react").SetStateAction<SocksCapConfig | null>>;
  cfg: SocksCapConfig | null;
  priorityOrderedProfiles: import("./configuration").IndexedProfile[];
  subInput: string;
  setBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setSubInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  setShowSubImport: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}

export function createProfileActions(context: CreateProfileActionsContext) {
  const { locked, report, t, setCfg, cfg, priorityOrderedProfiles, subInput, setBusy, setSubInput, setShowSubImport } = context;

  const persistConfig = async (next: SocksCapConfig) => {
    if (locked) {
      report(t("sockscap.lockedTooltip"), false);
      return false;
    }
    try {
      await sockscapSetConfig(next);
      setCfg(next);
      report(t("sockscap.saved"));
      return true;
    } catch (e) {
      report(String(e), false);
      return false;
    }
  };

  const patchSelectedProfile = async (
    partial: Partial<SocksCapProfile>,
  ): Promise<SocksCapConfig | null> => {
    if (!cfg) return null;
    const profiles = cfg.profiles.map((p) => {
      if (p.id === cfg.selectedProfileId) {
        return { ...p, ...partial };
      }
      return p;
    });
    const updatedSelected = profiles.find((p) => p.id === cfg.selectedProfileId) || profiles[0];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      mode: updatedSelected.mode,
      apps: updatedSelected.apps,
      upstream: updatedSelected.upstream,
      ruleMode: updatedSelected.ruleMode,
      userRules: updatedSelected.userRules,
      defaultAction: updatedSelected.defaultAction,
    };
    return (await persistConfig(nextCfg)) ? nextCfg : null;
  };

  const setProfilePriority = async (id: string, value: number) => {
    if (!cfg || !Number.isFinite(value)) return;
    const priority = Math.max(
      MIN_PROFILE_PRIORITY,
      Math.min(MAX_PROFILE_PRIORITY, Math.trunc(value)),
    );
    const profile = cfg.profiles.find((p) => p.id === id);
    if (!profile || profile.priority === priority) return;
    await persistConfig({
      ...cfg,
      profiles: cfg.profiles.map((p) => (p.id === id ? { ...p, priority } : p)),
    });
  };

  const moveProfilePriority = async (id: string, direction: -1 | 1) => {
    if (!cfg) return;
    const from = priorityOrderedProfiles.findIndex(({ profile }) => profile.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= priorityOrderedProfiles.length) return;

    const targetPriority = priorityOrderedProfiles[to].profile.priority;
    const reordered = [...priorityOrderedProfiles];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // Preserve the manually chosen values on every other profile. The moved
    // profile adopts its new neighbour's value; persisting the display order
    // also makes equal-priority ties deterministic (the backend is stable).
    await persistConfig({
      ...cfg,
      profiles: reordered.map(({ profile }) =>
        profile.id === id ? { ...profile, priority: targetPriority } : profile,
      ),
    });
  };

  const toggleProfileActive = async (id: string) => {
    if (!cfg) return;
    let activeProfileIds: string[];
    if (cfg.activeProfileIds.includes(id)) {
      if (cfg.activeProfileIds.length === 1) {
        report(t("sockscap.atLeastOneActive"), false);
        return;
      }
      activeProfileIds = cfg.activeProfileIds.filter((x) => x !== id);
    } else {
      activeProfileIds = [...cfg.activeProfileIds, id];
    }
    const nextCfg = { ...cfg, activeProfileIds };
    await persistConfig(nextCfg);
  };

  const selectProfile = (id: string) => {
    if (!cfg) return;
    const prof = cfg.profiles.find((p) => p.id === id);
    if (!prof) return;
    const nextCfg: SocksCapConfig = {
      ...cfg,
      selectedProfileId: id,
      mode: prof.mode,
      apps: prof.apps,
      upstream: prof.upstream,
      ruleMode: prof.ruleMode,
      userRules: prof.userRules,
      defaultAction: prof.defaultAction,
    };
    setCfg(nextCfg);
  };

  const addProfile = async () => {
    if (!cfg || locked) return;
    const newId = "prof-" + Date.now().toString(36);
    const newProf: SocksCapProfile = {
      id: newId,
      name: `方案 ${cfg.profiles.length + 1}`,
      icon: "🎮",
      color: null,
      enabled: true,
      priority: cfg.profiles.length,
      mode: "global",
      apps: [],
      upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
      ruleMode: "gfwList",
      userRules: [],
      defaultAction: "direct",
    };
    const profiles = [...cfg.profiles, newProf];
    const activeProfileIds = [...cfg.activeProfileIds, newId];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId: newId,
      mode: newProf.mode,
      apps: newProf.apps,
      upstream: newProf.upstream,
      ruleMode: newProf.ruleMode,
      userRules: newProf.userRules,
      defaultAction: newProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report(t("sockscap.profileCreated", { name: newProf.name }));
  };

  /** Import a subscription (URL or pasted blob): fetch+parse into nodes, vault
   *  each node's secret/uuid, and create one profile per node. Imported profiles
   *  are NOT auto-activated (avoids spawning many cores at once); the user
   *  activates the one they want. Selects the first imported node. */
  const onImportSubscription = async () => {
    if (!cfg || locked || !subInput.trim()) return;
    setBusy(true);
    try {
      const nodes = await sockscapImportSubscription(subInput.trim());
      // Vault status once up front (all nodes share the vault gate).
      const vs = await vaultStatus().catch(() => null);
      const needsVault = nodes.some((n) => n.secret || n.uuid);
      if (needsVault && (!vs || vs.state !== "unlocked")) {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("sockscap.vaultLocked") },
          }),
        );
        report(t("sockscap.vaultLocked"), false);
        return;
      }

      const newProfiles: SocksCapProfile[] = [];
      for (let i = 0;i < nodes.length;i++) {
        const n = nodes[i];
        const params: UpstreamParams = { ...n.params };
        let passwordRef = "";
        if (n.secret) {
          const res = await vaultPut(
            "sockscap_upstream_password",
            "SocksCap Upstream Password",
            n.secret,
          );
          passwordRef = res.reference;
        }
        if (n.uuid) {
          const res = await vaultPut(
            "sockscap_upstream_uuid",
            "SocksCap Upstream UUID",
            n.uuid,
          );
          params.uuidRef = res.reference;
        }
        newProfiles.push({
          id: `prof-${Date.now().toString(36)}-${i}`,
          name: n.name || `${n.host}:${n.port}`,
          icon: "🌐",
          color: null,
          enabled: true,
          priority: cfg.profiles.length + i,
          mode: "global",
          apps: [],
          upstream: {
            kind: n.kindTag as UpstreamKind,
            sessionId: "",
            host: n.host,
            port: n.port,
            username: "",
            passwordRef,
            params,
          },
          ruleMode: "gfwList",
          userRules: [],
          defaultAction: "direct",
        });
      }

      const profiles = [...cfg.profiles, ...newProfiles];
      const firstId = newProfiles[0].id;
      const sel = profiles.find((p) => p.id === firstId) || profiles[0];
      const nextCfg: SocksCapConfig = {
        ...cfg,
        profiles,
        selectedProfileId: firstId,
        mode: sel.mode,
        apps: sel.apps,
        upstream: sel.upstream,
        ruleMode: sel.ruleMode,
        userRules: sel.userRules,
        defaultAction: sel.defaultAction,
      };
      await persistConfig(nextCfg);
      setSubInput("");
      setShowSubImport(false);
      report(t("sockscap.subImported", { count: String(newProfiles.length) }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const duplicateProfile = async (prof: SocksCapProfile) => {
    if (!cfg || locked) return;
    const newId = "prof-" + Date.now().toString(36);
    const newProf: SocksCapProfile = {
      ...prof,
      id: newId,
      name: `${prof.name} (副本)`,
      priority: cfg.profiles.length,
    };
    const profiles = [...cfg.profiles, newProf];
    const activeProfileIds = [...cfg.activeProfileIds, newId];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId: newId,
      mode: newProf.mode,
      apps: newProf.apps,
      upstream: newProf.upstream,
      ruleMode: newProf.ruleMode,
      userRules: newProf.userRules,
      defaultAction: newProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report(t("sockscap.profileDuplicated", { name: newProf.name }));
  };

  const deleteProfile = async (id: string) => {
    if (locked) return;
    if (!cfg || cfg.profiles.length <= 1) {
      report(t("sockscap.atLeastOneProfile"), false);
      return;
    }
    const profiles = cfg.profiles.filter((p) => p.id !== id);
    const activeProfileIds = cfg.activeProfileIds.filter((x) => x !== id);
    if (activeProfileIds.length === 0 && profiles.length > 0) {
      activeProfileIds.push(profiles[0].id);
    }
    const selectedProfileId = cfg.selectedProfileId === id ? profiles[0].id : cfg.selectedProfileId;
    const selectedProf = profiles.find((p) => p.id === selectedProfileId) || profiles[0];
    const nextCfg: SocksCapConfig = {
      ...cfg,
      profiles,
      activeProfileIds,
      selectedProfileId,
      mode: selectedProf.mode,
      apps: selectedProf.apps,
      upstream: selectedProf.upstream,
      ruleMode: selectedProf.ruleMode,
      userRules: selectedProf.userRules,
      defaultAction: selectedProf.defaultAction,
    };
    await persistConfig(nextCfg);
    report("方案已删除");
  };
  return { patchSelectedProfile, persistConfig, addProfile, selectProfile, onImportSubscription, toggleProfileActive, duplicateProfile, deleteProfile, moveProfilePriority, setProfilePriority };
}
