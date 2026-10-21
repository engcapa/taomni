import { ChevronDown, ChevronRight, Search, Trash2 } from "lucide-react";
import { sockscapClearDomainRecords, type DomainRecord, type SocksCapConfig, type SocksCapProfile } from "../../../lib/sockscap";
import { formatBytes, formatTime } from "./formatting";

export interface TrafficSectionProps {
  domainsExpanded: boolean;
  setDomainsExpanded: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  domainRecords: DomainRecord[];
  domainFilter: string;
  setDomainFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
  decisionFilter: "direct" | "proxy" | "block" | "all";
  setDecisionFilter: import("react").Dispatch<import("react").SetStateAction<"direct" | "proxy" | "block" | "all">>;
  topNLimit: number;
  setTopNLimit: import("react").Dispatch<import("react").SetStateAction<number>>;
  setDomainRecords: import("react").Dispatch<import("react").SetStateAction<DomainRecord[]>>;
  filteredDomainRecords: DomainRecord[];
  locked: boolean;
  t: import("../../../lib/i18n").TranslateFn;
  cfg: SocksCapConfig | null;
  selectedProf: SocksCapProfile;
  patchSelectedProfile: (partial: Partial<SocksCapProfile>) => Promise<SocksCapConfig | null>;
}

export function TrafficSection(viewProps: TrafficSectionProps) {
  return (<div className="rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] overflow-hidden">
    <button
      type="button"
      data-testid="sockscap-domains-toggle"
      className="w-full px-3 py-2 text-left text-[11px] font-semibold flex items-center justify-between hover:bg-[var(--taomni-hover)] transition-colors"
      aria-expanded={viewProps.domainsExpanded}
      aria-controls="sockscap-domains-content"
      onClick={() => viewProps.setDomainsExpanded(!viewProps.domainsExpanded)}
    >
      <div className="flex items-center gap-2">
        {viewProps.domainsExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span>Captured Domains & Flow History</span>
        <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--taomni-hover)] font-normal text-[var(--taomni-text-muted)]">
          {viewProps.domainRecords.length} entries
        </span>
      </div>
      <span className="text-[10px] font-normal text-[var(--taomni-text-muted)]">
        {viewProps.domainsExpanded ? "Click to collapse" : "Click to expand"}
      </span>
    </button>

    {viewProps.domainsExpanded && (
      <div id="sockscap-domains-content" className="p-3 border-t border-[var(--taomni-divider)] space-y-3">
        {/* Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-[220px]">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[var(--taomni-text-muted)]" />
              <input
                className="w-full text-[11px] pl-7 pr-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]"
                placeholder="Search domain, IP, profile or process..."
                value={viewProps.domainFilter}
                onChange={(e) => viewProps.setDomainFilter(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded border border-[var(--taomni-divider)] p-0.5 text-[10px]">
              {(["all", "proxy", "direct", "block"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`px-2 py-0.5 rounded capitalize transition-colors ${viewProps.decisionFilter === mode
                    ? "bg-[var(--taomni-accent)] text-white font-medium"
                    : "hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                    }`}
                  onClick={() => viewProps.setDecisionFilter(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>

            <select
              className="text-[10px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)]"
              value={viewProps.topNLimit}
              onChange={(e) => viewProps.setTopNLimit(Number(e.target.value))}
            >
              <option value={50}>Top 50</option>
              <option value={100}>Top 100</option>
              <option value={200}>All (max 200)</option>
            </select>

            <button
              type="button"
              className="px-2 py-1 rounded text-[10px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-1 text-[var(--taomni-text-muted)]"
              onClick={() => {
                void sockscapClearDomainRecords();
                viewProps.setDomainRecords([]);
              }}
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="max-h-[280px] overflow-auto rounded border border-[var(--taomni-divider)]">
          <table className="w-full text-[11px] text-left border-collapse">
            <thead className="sticky top-0 bg-[var(--taomni-panel-bg)] border-b border-[var(--taomni-divider)] text-[10px] text-[var(--taomni-text-muted)] uppercase">
              <tr>
                <th className="py-1.5 px-2">Domain / IP</th>
                <th className="py-1.5 px-2">Decision</th>
                <th className="py-1.5 px-2">Profile</th>
                <th className="py-1.5 px-2">Matched Rule</th>
                <th className="py-1.5 px-2">Process (PID)</th>
                <th className="py-1.5 px-2 text-right">Hits</th>
                <th className="py-1.5 px-2 text-right">Data Transferred</th>
                <th className="py-1.5 px-2 text-right">Last Seen</th>
                <th className="py-1.5 px-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--taomni-divider)]">
              {viewProps.filteredDomainRecords.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-4 text-center text-[10px] text-[var(--taomni-text-muted)]">
                    No domain records captured yet. Start SocksCap and browse network to inspect live domain traffic.
                  </td>
                </tr>
              ) : (
                viewProps.filteredDomainRecords.slice(0, viewProps.topNLimit).map((rec) => (
                  <tr key={rec.key} className="hover:bg-[var(--taomni-hover)] transition-colors">
                    <td className="py-1.5 px-2 font-mono font-medium truncate max-w-[180px]" title={rec.domainOrIp}>
                      {rec.domainOrIp}
                    </td>
                    <td className="py-1.5 px-2">
                      {rec.decision === "proxy" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                          PROXY
                        </span>
                      )}
                      {rec.decision === "direct" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20">
                          DIRECT
                        </span>
                      )}
                      {rec.decision === "block" && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                          BLOCK
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 font-medium text-[var(--taomni-accent)] truncate max-w-[100px]" title={rec.profileName || "-"}>
                      {rec.profileName || "-"}
                    </td>
                    <td className="py-1.5 px-2 text-[var(--taomni-text-muted)] truncate max-w-[140px]" title={rec.matchedRule || "-"}>
                      {rec.matchedRule || "-"}
                    </td>
                    <td className="py-1.5 px-2 text-[var(--taomni-text-muted)]">
                      {rec.processName ? (
                        <span>{rec.processName} {rec.pid ? `(${rec.pid})` : ""}</span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-mono">{rec.hitCount}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-mono">
                      {formatBytes(rec.bytesUp + rec.bytesDown)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-mono text-[var(--taomni-text-muted)]">
                      {formatTime(rec.lastSeenUnix)}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded text-[9px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={viewProps.locked}
                        title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
                        onClick={() => {
                          if (!viewProps.cfg) return;
                          const pattern = rec.domainOrIp;
                          if (viewProps.selectedProf.userRules.some((r) => r.pattern === pattern)) return;
                          const updatedRules = [
                            { pattern, action: rec.decision === "proxy" ? ("proxy" as const) : ("direct" as const) },
                            ...viewProps.selectedProf.userRules,
                          ];
                          void viewProps.patchSelectedProfile({ userRules: updatedRules });
                        }}
                      >
                        + User Rule
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </div>);
}
