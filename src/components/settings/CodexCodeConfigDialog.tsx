import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Loader2, Plus, Sliders, Trash2, X } from "lucide-react";
import { CodexCustomConfigProfile, useAiStore } from "../../stores/aiStore";
import {
  codexGetProfileConfig,
  isVaultLockedError,
  VAULT_LOCKED_EVENT,
  vaultDelete,
  vaultPut,
  vaultStatus,
  vaultUpdate,
} from "../../lib/ipc";

const CONFIG_TEMPLATE = `{
  "model_reasoning_effort": "medium",
  "model_verbosity": "medium"
}`;

interface Props {
  onClose: () => void;
}

export function CodexCodeConfigDialog({ onClose }: Props) {
  const { config, saveConfig } = useAiStore();
  const [profiles, setProfiles] = useState<CodexCustomConfigProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [testError, setTestError] = useState<string | null>(null);
  const testSessionRef = useRef(0);

  useEffect(() => {
    if (!config) return;
    const codex = config.codex_bridge;
    const next = [...(codex.custom_config_profiles ?? [])];
    setProfiles(next);
    setActiveProfileId(codex.active_profile_id);
    if (next.length > 0) {
      setSelectedProfileId(codex.active_profile_id && next.some((p) => p.id === codex.active_profile_id)
        ? codex.active_profile_id
        : next[0].id);
    }
  }, [config]);

  useEffect(() => {
    if (!selectedProfileId || contents[selectedProfileId] !== undefined) return;
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile?.vault_ref) {
      setContents((cur) => ({ ...cur, [selectedProfileId]: CONFIG_TEMPLATE }));
      return;
    }
    setLoading(true);
    setError(null);
    codexGetProfileConfig(profile.vault_ref)
      .then((text) => setContents((cur) => ({ ...cur, [selectedProfileId]: text ?? CONFIG_TEMPLATE })))
      .catch((e) => {
        if (!isVaultLockedError(e)) setError(String(e));
      })
      .finally(() => setLoading(false));
  }, [selectedProfileId, contents, profiles]);

  useEffect(() => {
    return () => {
      testSessionRef.current += 1;
      void invoke("codex_stop_session", { threadId: "codex_test_config_thread" }).catch(() => {});
    };
  }, []);

  const sortedProfiles = useMemo(
    () => profiles.filter((p) => !deleted.has(p.id)).sort((a, b) => a.created_at - b.created_at),
    [profiles, deleted],
  );
  const selected = selectedProfileId ? profiles.find((p) => p.id === selectedProfileId) : null;
  const selectedContent = selectedProfileId ? contents[selectedProfileId] ?? "" : "";

  const markDirty = (id: string) => setDirty((cur) => new Set(cur).add(id));

  const addProfile = () => {
    const id = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const p: CodexCustomConfigProfile = {
      id,
      name: `Codex config ${profiles.length + 1}`,
      enabled: true,
      vault_ref: "",
      created_at: Date.now(),
    };
    setProfiles((cur) => [...cur, p]);
    setContents((cur) => ({ ...cur, [id]: CONFIG_TEMPLATE }));
    setDirty((cur) => new Set(cur).add(id));
    setSelectedProfileId(id);
    if (!activeProfileId) setActiveProfileId(id);
  };

  const deleteProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(`删除配置 "${p.name}"？`)) return;
    setDeleted((cur) => new Set(cur).add(id));
    if (selectedProfileId === id) {
      const rest = sortedProfiles.filter((x) => x.id !== id);
      setSelectedProfileId(rest[0]?.id ?? null);
    }
    if (activeProfileId === id) {
      const rest = sortedProfiles.filter((x) => x.id !== id);
      setActiveProfileId(rest[0]?.id);
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const status = await vaultStatus().catch(() => null);
      if (!status || status.state !== "unlocked") {
        window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: { reason: "需要先解锁凭据库，才能保存 Codex 自定义 config。" },
        }));
        setError("需要先解锁凭据库。");
        return;
      }

      const validated: Record<string, string> = {};
      for (const id of dirty) {
        if (deleted.has(id)) continue;
        const parsed = JSON.parse(contents[id] ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Codex config 必须是 JSON object");
        }
        validated[id] = JSON.stringify(parsed, null, 2);
      }

      for (const id of deleted) {
        const p = profiles.find((x) => x.id === id);
        if (p?.vault_ref.startsWith("vault:")) {
          await vaultDelete(p.vault_ref.slice("vault:".length)).catch(() => {});
        }
      }

      const updated: CodexCustomConfigProfile[] = [];
      for (const p of profiles) {
        if (deleted.has(p.id)) continue;
        let vaultRef = p.vault_ref;
        if (dirty.has(p.id)) {
          const text = validated[p.id];
          if (vaultRef.startsWith("vault:")) {
            await vaultUpdate(vaultRef.slice("vault:".length), text);
          } else {
            const res = await vaultPut("codex_bridge:config", `Codex config (${p.name})`, text);
            vaultRef = res.reference;
          }
        }
        updated.push({ ...p, vault_ref: vaultRef });
      }

      await saveConfig({
        ...config,
        codex_bridge: {
          ...config.codex_bridge,
          custom_config_profiles: updated,
          active_profile_id: activeProfileId,
        },
      });
      onClose();
    } catch (e) {
      if (!isVaultLockedError(e)) setError((e as Error).message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!selectedContent) return;
    testSessionRef.current += 1;
    const session = testSessionRef.current;
    setTesting(true);
    setTestOutput("");
    setTestError(null);
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<any>("codex-test-config-stream", (event) => {
        if (testSessionRef.current !== session) return;
        const payload = event.payload;
        if (payload.kind === "token") setTestOutput((cur) => cur + payload.content);
        if (payload.kind === "end") setTestOutput(payload.content);
        if (payload.kind === "error") setTestError(payload.message);
      });
      await invoke("codex_test_config", { configJson: selectedContent });
    } catch (e: any) {
      if (testSessionRef.current === session) setTestError(e?.message || String(e));
    } finally {
      unlisten?.();
      if (testSessionRef.current === session) setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <div className="w-[860px] max-w-[96%] max-h-[85vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}>
        <div className="h-7 flex items-center px-2 shrink-0" style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}>
          <Sliders className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">Codex 自定义 config</div>
          <button className="ml-auto hover:bg-red-500 rounded p-0.5" onClick={onClose} type="button" title="关闭">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex border-x border-b overflow-hidden" style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}>
          <div className="w-[240px] border-r flex flex-col shrink-0" style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}>
            <div className="p-2 border-b text-[11px] font-semibold" style={{ borderColor: "var(--taomni-divider)" }}>Profiles</div>
            <div className="flex-1 overflow-auto p-1.5 space-y-1">
              {sortedProfiles.map((p) => (
                <div key={p.id}
                  className={`group flex items-center justify-between p-2 rounded cursor-pointer text-[11px] ${selectedProfileId === p.id ? "bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] font-medium" : "hover:bg-[var(--taomni-hover)]"}`}
                  onClick={() => setSelectedProfileId(p.id)}>
                  <div className="min-w-0">
                    <div className="truncate">{p.name}</div>
                    <div className="text-[9px] text-[var(--taomni-text-muted)]">{activeProfileId === p.id ? "active" : p.enabled ? "enabled" : "disabled"}</div>
                  </div>
                  <button type="button" className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/15 rounded" onClick={(e) => { e.stopPropagation(); deleteProfile(p.id); }}>
                    <Trash2 className="w-3 h-3 text-red-400" />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="m-2 taomni-btn h-7 text-[11px] inline-flex items-center justify-center gap-1" onClick={addProfile}>
              <Plus className="w-3 h-3" />
              新增
            </button>
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            {selected ? (
              <>
                <div className="p-3 border-b space-y-2" style={{ borderColor: "var(--taomni-divider)" }}>
                  <input className="taomni-input h-7 w-full text-[12px]" value={selected.name}
                    onChange={(e) => {
                      setProfiles((cur) => cur.map((p) => p.id === selected.id ? { ...p, name: e.target.value } : p));
                    }} />
                  <div className="flex items-center gap-4 text-[11px]">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={selected.enabled}
                        onChange={(e) => setProfiles((cur) => cur.map((p) => p.id === selected.id ? { ...p, enabled: e.target.checked } : p))} />
                      启用
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={activeProfileId === selected.id} onChange={() => setActiveProfileId(selected.id)} />
                      当前使用
                    </label>
                  </div>
                </div>
                <textarea className="flex-1 min-h-[260px] w-full resize-none bg-[var(--taomni-bg)] text-[12px] font-mono p-3 outline-none"
                  spellCheck={false}
                  value={selectedContent}
                  onChange={(e) => {
                    setContents((cur) => ({ ...cur, [selected.id]: e.target.value }));
                    markDirty(selected.id);
                  }}
                />
                <div className="border-t p-2 space-y-2" style={{ borderColor: "var(--taomni-divider)" }}>
                  {loading && <div className="text-[11px] text-[var(--taomni-text-muted)]">读取中...</div>}
                  {error && <div className="text-[11px] text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{error}</div>}
                  {testError && <div className="text-[11px] text-red-400 whitespace-pre-wrap">{testError}</div>}
                  {testOutput && <div className="text-[11px] text-green-400 whitespace-pre-wrap">{testOutput}</div>}
                  <div className="flex justify-end gap-2">
                    <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={test} disabled={testing}>
                      {testing ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
                      测试
                    </button>
                    <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={onClose}>取消</button>
                    <button type="button" className="taomni-btn h-7 px-3 text-[12px] bg-[var(--taomni-accent)] text-white" onClick={save} disabled={saving}>
                      {saving ? "保存中..." : "保存"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">新增一个 Codex config profile 开始。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

