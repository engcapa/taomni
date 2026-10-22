import { HelpCircle, Loader2 } from "lucide-react";
import { upstreamRequiresCore, type LocalProxyCandidate, type SocksCapConfig, type SocksCapProfile, type UpstreamKind } from "../../../lib/sockscap";
import { UpstreamSourcePicker, type UpstreamChoice } from "../UpstreamSourcePicker";
import { type SessionOpt } from "./configuration";
import { Field } from "./Field";
import { Section } from "./Section";

export interface UpstreamSectionProps {
  t: import("../../../lib/i18n").TranslateFn;
  linuxLaunchOnly: boolean;
  detectedProxies: LocalProxyCandidate[];
  selectedProf: SocksCapProfile;
  locked: boolean;
  patchSelectedProfile: (partial: Partial<SocksCapProfile>) => Promise<SocksCapConfig | null>;
  shareLink: string;
  setShareLink: import("react").Dispatch<import("react").SetStateAction<string>>;
  onImportShareLink: () => Promise<void>;
  busy: boolean;
  sessions: SessionOpt[];
  onSelectUpstreamSource: (choice: UpstreamChoice) => void;
  rescanLocalProxies: () => Promise<void>;
  password: string;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  storePassword: () => Promise<void>;
  storingPass: boolean;
  clearPassword: () => Promise<void>;
  renderCoreParams: () => import("react").JSX.Element | null;
  onTestUpstream: () => Promise<void>;
  testing: boolean;
}

export function UpstreamSection(viewProps: UpstreamSectionProps) {
  return (<Section
    sectionId="upstream"
    title={viewProps.t("sockscap.section.upstream")}
    defaultExpanded={viewProps.linuxLaunchOnly}
  >
    {/* No local proxy detected → guide the user to run one correctly
                (proxy/SOCKS inbound only; NOT system-proxy/global, NOT TUN),
                then rescan or import a share link. Only for native socks5/http
                upstreams with no saved session picked. */}
    {viewProps.detectedProxies.length === 0 &&
      (viewProps.selectedProf.upstream.kind === "socks5" ||
        viewProps.selectedProf.upstream.kind === "http") &&
      !viewProps.selectedProf.upstream.sessionId && (
        <div
          data-testid="sockscap-noproxy-help"
          className="mb-3 px-3 py-2 rounded text-[11px] border border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300"
        >
          <div className="flex items-center gap-1.5 font-semibold mb-1">
            <HelpCircle className="w-3.5 h-3.5 shrink-0" />
            {viewProps.t("sockscap.noProxyHelpTitle")}
          </div>
          <ol className="list-decimal pl-4 space-y-0.5 text-[var(--taomni-text-muted)]">
            <li>{viewProps.t("sockscap.noProxyHelpStep1")}</li>
            <li>{viewProps.t("sockscap.noProxyHelpStep2")}</li>
            <li>{viewProps.t("sockscap.noProxyHelpStep3")}</li>
            <li>{viewProps.t("sockscap.noProxyHelpStep4")}</li>
          </ol>
        </div>
      )}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Field label={viewProps.t("sockscap.upstreamKind")}>
        <select
          data-testid="sockscap-upstream-kind"
          className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
          value={viewProps.selectedProf.upstream.kind}
          disabled={viewProps.locked}
          title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
          onChange={(e) =>
            void viewProps.patchSelectedProfile({
              upstream: {
                ...viewProps.selectedProf.upstream,
                kind: e.target.value as UpstreamKind,
              },
            })
          }
        >
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP / HTTPS</option>
          <option value="ssh">SSH Tunnel (Dynamic SOCKS)</option>
          <option value="shadowsocks">Shadowsocks</option>
          <option value="trojan">Trojan</option>
          <option value="vmess">VMess</option>
          <option value="vless">VLESS</option>
          <option value="wireguard">WireGuard</option>
        </select>
      </Field>

      {upstreamRequiresCore(viewProps.selectedProf.upstream.kind) ? (
        <Field label={viewProps.t("sockscap.shareLinkImport")}>
          <div className="flex gap-1.5">
            <input
              data-testid="sockscap-sharelink-input"
              className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
              placeholder="ss:// vmess:// vless:// trojan://"
              value={viewProps.shareLink}
              disabled={viewProps.locked}
              title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
              onChange={(e) => viewProps.setShareLink(e.target.value)}
            />
            <button
              type="button"
              data-testid="sockscap-sharelink-import"
              className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void viewProps.onImportShareLink()}
              disabled={viewProps.busy || viewProps.locked || !viewProps.shareLink.trim()}
            >
              {viewProps.t("sockscap.shareLinkImportBtn")}
            </button>
          </div>
        </Field>
      ) : (
        <Field label={viewProps.t("sockscap.upstreamSource")}>
          <UpstreamSourcePicker
            key={viewProps.selectedProf.id}
            mode={viewProps.selectedProf.upstream.kind === "ssh" ? "ssh" : "proxy"}
            detected={viewProps.detectedProxies}
            sessions={viewProps.sessions}
            current={viewProps.selectedProf.upstream}
            onSelect={viewProps.onSelectUpstreamSource}
            onRescan={viewProps.rescanLocalProxies}
            busy={viewProps.busy}
            disabled={viewProps.locked}
            lockedTooltip={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
            t={viewProps.t}
          />
        </Field>
      )}

      <Field label={viewProps.t("sockscap.host")}>
        <input
          className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
          value={viewProps.selectedProf.upstream.host}
          disabled={viewProps.locked}
          title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
          onChange={(e) =>
            void viewProps.patchSelectedProfile({
              upstream: { ...viewProps.selectedProf.upstream, host: e.target.value },
            })
          }
        />
      </Field>
      <Field label={viewProps.t("sockscap.port")}>
        <input
          type="number"
          className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
          value={viewProps.selectedProf.upstream.port}
          disabled={viewProps.locked}
          title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
          onChange={(e) =>
            void viewProps.patchSelectedProfile({
              upstream: {
                ...viewProps.selectedProf.upstream,
                port: parseInt(e.target.value, 10) || 1080,
              },
            })
          }
        />
      </Field>
      <Field label={viewProps.t("sockscap.username")}>
        <input
          className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
          value={viewProps.selectedProf.upstream.username || ""}
          disabled={viewProps.locked}
          title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
          onChange={(e) =>
            void viewProps.patchSelectedProfile({
              upstream: { ...viewProps.selectedProf.upstream, username: e.target.value },
            })
          }
        />
      </Field>
      <Field label={viewProps.t("sockscap.password")}>
        <div className="flex gap-1.5">
          <input
            type="password"
            className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
            placeholder={
              viewProps.selectedProf.upstream.passwordRef
                ? viewProps.t("sockscap.passwordStored")
                : viewProps.t("sockscap.passwordPh")
            }
            value={viewProps.password}
            disabled={viewProps.locked}
            title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
            onChange={(e) => viewProps.setPassword(e.target.value)}
          />
          <button
            type="button"
            className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void viewProps.storePassword()}
            disabled={viewProps.storingPass || viewProps.locked || !viewProps.password}
          >
            {viewProps.t("sockscap.passwordStore")}
          </button>
          {viewProps.selectedProf.upstream.passwordRef && (
            <button
              type="button"
              className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] text-red-500 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void viewProps.clearPassword()}
              disabled={viewProps.locked}
            >
              {viewProps.t("common.clear")}
            </button>
          )}
        </div>
      </Field>

      {viewProps.renderCoreParams()}
    </div>
    <div className="mt-3 flex gap-2">
      <button
        type="button"
        data-testid="sockscap-test-upstream"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
        onClick={() => void viewProps.onTestUpstream()}
        disabled={viewProps.busy || viewProps.testing}
      >
        {viewProps.testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {viewProps.testing ? viewProps.t("sockscap.testing") : viewProps.t("sockscap.testUpstream")}
      </button>
    </div>
  </Section>);
}
