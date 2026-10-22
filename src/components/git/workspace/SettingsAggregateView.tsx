import { useState } from "react";
import { Search } from "lucide-react";
import { type GitSnapshot } from "../../../lib/git";
import type { GitWorkspaceRootInfo } from "../../../types";
import { type RepoSnapshotState,workspaceRemoteSummary } from "./model";
import { EmptyState } from "./controls";


export const WORKSPACE_SETTING_FIELDS: Array<{ key: keyof GitSnapshot["settings"]; label: string; }>=[
  { key: "userName",label: "user.name" },
  { key: "userEmail",label: "user.email" },
  { key: "httpProxy",label: "http.proxy" },
  { key: "httpsProxy",label: "https.proxy" },
  { key: "pullRebase",label: "pull.rebase" },
  { key: "pushDefault",label: "push.default" },
  { key: "coreAutocrlf",label: "core.autocrlf" },
  { key: "coreFilemode",label: "core.filemode" },
  { key: "commitGpgsign",label: "commit.gpgsign" },
];


export function WorkspaceSettingsAggregateView({
  roots,
  snapshots,
  onSelectRepo,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string,RepoSnapshotState>;
  onSelectRepo: (repoRoot: string) => void;
}) {
  const [query,setQuery]=useState("");
  const normalizedQuery=query.trim().toLowerCase();
  const rows=roots.filter((root) => {
    if(!normalizedQuery) return true;
    const snapshot=snapshots[root.repoRoot]?.snapshot??null;
    const haystack=[
      root.name,
      root.repoRoot,
      ...WORKSPACE_SETTING_FIELDS.map((field) => snapshot?.settings[field.key]??""),
      ...(snapshot?.remotes??[]).flatMap((remote) => [
        remote.name,
        remote.fetchUrl,
        remote.pushUrl??"",
        remote.username??"",
        remote.tokenRef? "token stored":"no token",
      ]),
    ].join("\n").toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-72 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">
          {rows.length}/{roots.length} repositories
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {rows.length===0? (
          <EmptyState title="No repositories match" />
        ):(
          <table className="min-w-[1120px] w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-[var(--taomni-quick-bg)]">
              <tr className="border-b border-[var(--taomni-divider)] text-left">
                <th className="w-52 px-3 py-2 font-medium">Repository</th>
                {WORKSPACE_SETTING_FIELDS.map((field) => (
                  <th key={field.key} className="px-2 py-2 font-medium">{field.label}</th>
                ))}
                <th className="w-72 px-2 py-2 font-medium">Remotes</th>
                <th className="w-20 px-2 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((root) => {
                const state=snapshots[root.repoRoot];
                const snapshot=state?.snapshot??null;
                return (
                  <tr key={root.repoRoot} className="border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium truncate" title={root.repoRoot}>{root.name}</div>
                      <div className="text-[11px] text-[var(--taomni-text-muted)] truncate" title={root.repoRoot}>
                        {root.repoRoot}
                      </div>
                    </td>
                    {WORKSPACE_SETTING_FIELDS.map((field) => (
                      <td key={field.key} className="px-2 py-2 align-top">
                        <div className="max-w-40 truncate" title={snapshot?.settings[field.key]??"(unset)"}>
                          {snapshot? snapshot.settings[field.key]??"(unset)":state?.loading? "Loading...":"(unknown)"}
                        </div>
                      </td>
                    ))}
                    <td className="px-2 py-2 align-top">
                      <div className="max-w-72 truncate" title={snapshot? workspaceRemoteSummary(snapshot):""}>
                        {snapshot? workspaceRemoteSummary(snapshot):state?.loading? "Loading...":"(unknown)"}
                      </div>
                    </td>
                    <td className="px-2 py-2 align-top text-right">
                      <button
                        type="button"
                        className="taomni-btn h-7 px-2 text-[12px]"
                        onClick={() => onSelectRepo(root.repoRoot)}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
