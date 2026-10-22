import { useState,type ReactNode } from "react";
import { GitBranch,Plus,Save,Settings,Trash2 } from "lucide-react";
import { type GitRemote,type GitRepoSettings,type GitSnapshot } from "../../../lib/git";
import { type WorkspaceSettingsAggregateView,type RemoteDraft,remoteDraft,emptyToNull } from "./model";
import { EmptyState } from "./controls";


export function WorkspaceSettingsSwitcher({
  currentView,
  aggregateView,
}: {
  currentView: ReactNode;
  aggregateView?: WorkspaceSettingsAggregateView;
}) {
  const [mode,setMode]=useState<"current"|"aggregate">("current");

  if(!aggregateView) return <>{currentView}</>;

  const showCurrent=() => setMode("current");
  const aggregate=typeof aggregateView==="function"? aggregateView(showCurrent):aggregateView;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <div className="inline-flex h-7 rounded border border-[var(--taomni-divider)] overflow-hidden">
          <button
            type="button"
            className={`px-2 text-[12px] ${mode==="current"? "bg-[var(--taomni-hover)]":"hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setMode("current")}
          >
            Current Repository
          </button>
          <button
            type="button"
            className={`px-2 text-[12px] border-l border-[var(--taomni-divider)] ${mode==="aggregate"? "bg-[var(--taomni-hover)]":"hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setMode("aggregate")}
          >
            Aggregate
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {mode==="current"? currentView:aggregate}
      </div>
    </div>
  );
}


export function SettingsView({
  snapshot,
  settings,
  setSettings,
  remoteDrafts,
  setRemoteDrafts,
  busy,
  onSaveSettings,
  onSaveRemote,
  onClearToken,
  onDeleteRemote,
  onAddRemote,
}: {
  snapshot: GitSnapshot|null;
  settings: GitRepoSettings;
  setSettings: (settings: GitRepoSettings) => void;
  remoteDrafts: Record<string,RemoteDraft>;
  setRemoteDrafts: (drafts: Record<string,RemoteDraft>) => void;
  busy: boolean;
  onSaveSettings: () => void;
  onSaveRemote: (remote: GitRemote,draft: RemoteDraft) => void;
  onClearToken: (remote: GitRemote) => void;
  onDeleteRemote: (remote: GitRemote) => void;
  onAddRemote: () => void;
}) {
  const remotes=snapshot?.remotes??[];
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="max-w-[1100px] p-4 space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Settings className="w-4 h-4" />
            <h2 className="font-semibold">Repository config</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onSaveSettings}>
              <Save className="w-3.5 h-3.5 mr-1" /> Save config
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <SettingInput label="user.name" value={settings.userName} onChange={(value) => setSettings({ ...settings,userName: value })} />
            <SettingInput label="user.email" value={settings.userEmail} onChange={(value) => setSettings({ ...settings,userEmail: value })} />
            <SettingInput label="http.proxy" value={settings.httpProxy} onChange={(value) => setSettings({ ...settings,httpProxy: value })} />
            <SettingInput label="https.proxy" value={settings.httpsProxy} onChange={(value) => setSettings({ ...settings,httpsProxy: value })} />
            <SettingInput label="pull.rebase" value={settings.pullRebase} onChange={(value) => setSettings({ ...settings,pullRebase: value })} />
            <SettingInput label="push.default" value={settings.pushDefault} onChange={(value) => setSettings({ ...settings,pushDefault: value })} />
            <SettingInput label="core.autocrlf" value={settings.coreAutocrlf} onChange={(value) => setSettings({ ...settings,coreAutocrlf: value })} />
            <SettingInput label="core.filemode" value={settings.coreFilemode} onChange={(value) => setSettings({ ...settings,coreFilemode: value })} />
            <SettingInput label="commit.gpgsign" value={settings.commitGpgsign} onChange={(value) => setSettings({ ...settings,commitGpgsign: value })} />
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <GitBranch className="w-4 h-4" />
            <h2 className="font-semibold">Remotes and credentials</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onAddRemote}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add remote
            </button>
          </div>
          <div className="space-y-3">
            {remotes.length===0? <EmptyState title="No remotes configured" />:remotes.map((remote) => {
              const draft=remoteDrafts[remote.name]??remoteDraft(remote);
              const updateDraft=(next: RemoteDraft) => setRemoteDrafts({ ...remoteDrafts,[remote.name]: next });
              return (
                <div key={remote.name} className="border border-[var(--taomni-divider)] rounded-md overflow-hidden">
                  <div className="h-8 flex items-center px-3 bg-[var(--taomni-quick-bg)] border-b border-[var(--taomni-divider)]">
                    <span className="font-semibold">{remote.name}</span>
                    <span className="ml-2 text-[11px] text-[var(--taomni-text-muted)]">{remote.tokenRef? "token stored in Vault":"no token"}</span>
                    <div className="flex-1" />
                    <button className="taomni-btn h-6 px-2" type="button" disabled={busy} onClick={() => onSaveRemote(remote,draft)}>Save</button>
                    <button className="taomni-btn h-6 px-2 ml-1" type="button" disabled={busy||!remote.tokenRef} onClick={() => onClearToken(remote)}>Clear token</button>
                    <button className="taomni-btn h-6 px-2 ml-1 text-red-500" type="button" disabled={busy} onClick={() => onDeleteRemote(remote)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-3 p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    <SettingInput label="name" value={draft.name} onChange={(value) => updateDraft({ ...draft,name: value??"" })} />
                    <SettingInput label="fetch URL" value={draft.fetchUrl} onChange={(value) => updateDraft({ ...draft,fetchUrl: value??"" })} />
                    <SettingInput label="push URL" value={draft.pushUrl} onChange={(value) => updateDraft({ ...draft,pushUrl: value??"" })} />
                    <SettingInput label="account / username" value={draft.username} onChange={(value) => updateDraft({ ...draft,username: value??"" })} />
                    <label className="text-[12px]">
                      <span className="block mb-1 text-[var(--taomni-text-muted)]">token</span>
                      <input
                        className="taomni-input w-full h-8"
                        type="password"
                        value={draft.token}
                        placeholder={remote.tokenRef? "Stored in Vault; enter new token to replace":"Personal access token"}
                        onChange={(event) => updateDraft({ ...draft,token: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}


export function SettingInput({ label,value,onChange }: { label: string; value: string|null; onChange: (value: string|null) => void; }) {
  return (
    <label className="text-[12px]">
      <span className="block mb-1 text-[var(--taomni-text-muted)]">{label}</span>
      <input className="taomni-input w-full h-8" value={value??""} onChange={(event) => onChange(emptyToNull(event.target.value))} />
    </label>
  );
}
