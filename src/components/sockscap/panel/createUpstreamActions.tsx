import {
  sockscapTestUpstream,
  sockscapTestCoreUpstream,
  sockscapParseShareLink,
  upstreamRequiresCore,
  type SocksCapConfig,
  type UpstreamKind,
  type UpstreamParams,
} from "../../../lib/sockscap";
import { vaultPut, vaultStatus, VAULT_LOCKED_EVENT } from "../../../lib/ipc";


export interface CreateUpstreamActionsContext {
  cfg: SocksCapConfig | null;
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  t: import("../../../lib/i18n").TranslateFn;
  selectedProf: import("../../../lib/sockscap").SocksCapProfile;
  password: string;
  report: (text: string, ok?: boolean) => void;
  summarize: (text: string) => string;
  openTestDetail: (title: string, body: string) => void;
  patchSelectedProfile: (partial: Partial<import("../../../lib/sockscap").SocksCapProfile>) => Promise<SocksCapConfig | null>;
  uuidInput: string;
  setBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setUuidInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  wgKeyInput: string;
  setWgKeyInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  shareLink: string;
  setShareLink: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
}

export function createUpstreamActions(context: CreateUpstreamActionsContext) {
  const {
    cfg,
    setTesting,
    t,
    selectedProf,
    password,
    report,
    summarize,
    openTestDetail,
    patchSelectedProfile,
    uuidInput,
    setBusy,
    setUuidInput,
    wgKeyInput,
    setWgKeyInput,
    shareLink,
    setShareLink,
    setPassword,
  } = context;

  const onTestUpstream = async () => {
    if (!cfg) return;
    setTesting(true);
    const title = t("sockscap.testUpstreamDetailTitle", {
      kind: selectedProf.upstream.kind,
    });
    try {
      const u = selectedProf.upstream;
      let text: string;
      // Core-backed kinds spawn a throwaway xray sidecar (secrets from vault).
      if (upstreamRequiresCore(u.kind)) {
        text = await sockscapTestCoreUpstream({
          upstream: u,
          testHost: "www.google.com",
          testPort: 443,
        });
      } else {
        text = await sockscapTestUpstream({
          kind: u.kind,
          host: u.host || "127.0.0.1",
          port: u.port || 1080,
          username: u.username,
          password: password || u.passwordRef || undefined,
          sessionId: u.sessionId || undefined,
          testHost: "www.google.com",
          testPort: 443,
        });
      }
      report(summarize(text));
      openTestDetail(title, text);
    } catch (e) {
      const err = String(e);
      report(summarize(err), false);
      openTestDetail(title, err);
    } finally {
      setTesting(false);
    }
  };

  /** Merge protocol-specific params into the selected profile's upstream. */
  const patchUpstreamParams = async (patch: Partial<UpstreamParams>) => {
    await patchSelectedProfile({
      upstream: {
        ...selectedProf.upstream,
        params: { ...(selectedProf.upstream.params || {}), ...patch },
      },
    });
  };

  /** Store a plaintext secret in the vault, returning its `vault:<id>` ref.
   *  Returns null (and surfaces a message) if the vault is locked. */
  const vaultStore = async (
    name: string,
    label: string,
    value: string,
  ): Promise<string | null> => {
    const status = await vaultStatus().catch(() => null);
    if (!status || status.state !== "unlocked") {
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: { reason: t("sockscap.vaultLocked") },
        }),
      );
      report(t("sockscap.vaultLocked"), false);
      return null;
    }
    const res = await vaultPut(name, label, value);
    return res.reference;
  };

  const storeUuid = async () => {
    if (!cfg || !uuidInput.trim()) return;
    setBusy(true);
    try {
      const ref = await vaultStore(
        "sockscap_upstream_uuid",
        "SocksCap Upstream UUID",
        uuidInput.trim(),
      );
      if (ref === null) return;
      await patchUpstreamParams({ uuidRef: ref });
      setUuidInput("");
      report(t("sockscap.secretStored"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const storeWgKey = async () => {
    if (!cfg || !wgKeyInput.trim()) return;
    setBusy(true);
    try {
      const ref = await vaultStore(
        "sockscap_upstream_wg_key",
        "SocksCap WireGuard Private Key",
        wgKeyInput.trim(),
      );
      if (ref === null) return;
      await patchUpstreamParams({ privateKeyRef: ref });
      setWgKeyInput("");
      report(t("sockscap.secretStored"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  /** Parse a pasted share link and populate the current profile's upstream,
   *  vaulting the secret (SS/trojan password) and uuid (vmess/vless). */
  const onImportShareLink = async () => {
    if (!cfg || !shareLink.trim()) return;
    setBusy(true);
    try {
      const parsed = await sockscapParseShareLink(shareLink.trim());
      const kind = parsed.kindTag as UpstreamKind;
      const params: UpstreamParams = { ...parsed.params };

      // Vault the primary secret (SS/trojan password) → passwordRef.
      let passwordRef = "";
      if (parsed.secret) {
        const ref = await vaultStore(
          "sockscap_upstream_password",
          "SocksCap Upstream Password",
          parsed.secret,
        );
        if (ref === null) return; // vault locked
        passwordRef = ref;
      }
      // Vault the uuid (vmess/vless) → params.uuidRef.
      if (parsed.uuid) {
        const ref = await vaultStore(
          "sockscap_upstream_uuid",
          "SocksCap Upstream UUID",
          parsed.uuid,
        );
        if (ref === null) return;
        params.uuidRef = ref;
      }

      await patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          kind,
          sessionId: "",
          host: parsed.host,
          port: parsed.port,
          passwordRef,
          params,
        },
      });
      setShareLink("");
      setPassword("");
      report(
        t("sockscap.shareLinkImported", {
          name: parsed.name || `${parsed.host}:${parsed.port}`,
        }),
      );
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };
  return { storeUuid, patchUpstreamParams, storeWgKey, onImportShareLink, onTestUpstream };
}
