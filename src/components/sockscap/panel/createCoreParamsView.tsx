import { upstreamRequiresCore, type UpstreamParams } from "../../../lib/sockscap";
import { Field } from "./Field";


export interface CreateCoreParamsViewContext {
  selectedProf: import("../../../lib/sockscap").SocksCapProfile;
  t: import("../../../lib/i18n").TranslateFn;
  uuidInput: string;
  setUuidInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  storeUuid: () => Promise<void>;
  busy: boolean;
  patchUpstreamParams: (patch: Partial<UpstreamParams>) => Promise<void>;
  wgKeyInput: string;
  setWgKeyInput: import("react").Dispatch<import("react").SetStateAction<string>>;
  storeWgKey: () => Promise<void>;
  locked: boolean;
}

export function createCoreParamsView(context: CreateCoreParamsViewContext) {
  const { selectedProf, t, uuidInput, setUuidInput, storeUuid, busy, patchUpstreamParams, wgKeyInput, setWgKeyInput, storeWgKey, locked } = context;

  // Protocol-specific fields for core-backed upstreams. Secrets (uuid, wg key)
  // are stored in the vault; non-secret transport/TLS params are plain fields.
  const renderCoreParams = () => {
    const kind = selectedProf.upstream.kind;
    if (!upstreamRequiresCore(kind)) return null;
    const p: UpstreamParams = selectedProf.upstream.params || {};
    const cls =
      "w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]";
    const net = p.network || "tcp";
    const tls = p.tls || (kind === "trojan" ? "tls" : "none");
    const hasTransport = kind === "trojan" || kind === "vmess" || kind === "vless";
    const hasTls = hasTransport;

    const uuidField = (
      <Field label="UUID">
        <div className="flex gap-1.5">
          <input
            type="password"
            className={"flex-1 " + cls}
            placeholder={p.uuidRef ? t("sockscap.passwordStored") : "UUID"}
            value={uuidInput}
            onChange={(e) => setUuidInput(e.target.value)}
          />
          <button
            type="button"
            className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0"
            onClick={() => void storeUuid()}
            disabled={busy || !uuidInput}
          >
            {t("sockscap.passwordStore")}
          </button>
        </div>
      </Field>
    );

    const transportFields = hasTransport && (
      <>
        <Field label={t("sockscap.transport")}>
          <select
            className={cls}
            value={net}
            onChange={(e) => void patchUpstreamParams({ network: e.target.value })}
          >
            <option value="tcp">TCP</option>
            <option value="ws">WebSocket</option>
            <option value="grpc">gRPC</option>
            <option value="httpupgrade">HTTPUpgrade</option>
          </select>
        </Field>
        {(net === "ws" || net === "grpc" || net === "httpupgrade") && (
          <Field label={net === "grpc" ? t("sockscap.grpcService") : t("sockscap.wsPath")}>
            <input
              className={cls}
              value={p.path || ""}
              onChange={(e) => void patchUpstreamParams({ path: e.target.value })}
            />
          </Field>
        )}
        {(net === "ws" || net === "httpupgrade") && (
          <Field label={t("sockscap.wsHost")}>
            <input
              className={cls}
              value={p.wsHost || ""}
              onChange={(e) => void patchUpstreamParams({ wsHost: e.target.value })}
            />
          </Field>
        )}
      </>
    );

    const tlsFields = hasTls && (
      <>
        <Field label="TLS">
          <select
            className={cls}
            value={tls}
            onChange={(e) => void patchUpstreamParams({ tls: e.target.value })}
          >
            <option value="none">None</option>
            <option value="tls">TLS</option>
            <option value="reality">REALITY</option>
          </select>
        </Field>
        {(tls === "tls" || tls === "reality") && (
          <Field label="SNI">
            <input
              className={cls}
              value={p.sni || ""}
              onChange={(e) => void patchUpstreamParams({ sni: e.target.value })}
            />
          </Field>
        )}
        {tls === "reality" && (
          <>
            <Field label={t("sockscap.realityPbk")}>
              <input
                className={cls}
                value={p.realityPublicKey || ""}
                onChange={(e) =>
                  void patchUpstreamParams({ realityPublicKey: e.target.value })
                }
              />
            </Field>
            <Field label={t("sockscap.realitySid")}>
              <input
                className={cls}
                value={p.realityShortId || ""}
                onChange={(e) =>
                  void patchUpstreamParams({ realityShortId: e.target.value })
                }
              />
            </Field>
          </>
        )}
      </>
    );

    const wgFields = kind === "wireguard" && (
      <>
        <Field label={t("sockscap.wgPrivateKey")}>
          <div className="flex gap-1.5">
            <input
              type="password"
              className={"flex-1 " + cls}
              placeholder={p.privateKeyRef ? t("sockscap.passwordStored") : t("sockscap.wgPrivateKey")}
              value={wgKeyInput}
              onChange={(e) => setWgKeyInput(e.target.value)}
            />
            <button
              type="button"
              className="px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] shrink-0"
              onClick={() => void storeWgKey()}
              disabled={busy || !wgKeyInput}
            >
              {t("sockscap.passwordStore")}
            </button>
          </div>
        </Field>
        <Field label={t("sockscap.wgPeerKey")}>
          <input
            className={cls}
            value={p.peerPublicKey || ""}
            onChange={(e) => void patchUpstreamParams({ peerPublicKey: e.target.value })}
          />
        </Field>
        <Field label={t("sockscap.wgLocalAddr")}>
          <input
            className={cls}
            placeholder="10.0.0.2/32, fd00::2/128"
            value={(p.localAddress || []).join(", ")}
            onChange={(e) =>
              void patchUpstreamParams({
                localAddress: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </>
    );

    const vlessFlow = kind === "vless" && (
      <Field label={t("sockscap.vlessFlow")}>
        <select
          className={cls}
          value={p.flow || ""}
          onChange={(e) => void patchUpstreamParams({ flow: e.target.value })}
        >
          <option value="">None</option>
          <option value="xtls-rprx-vision">xtls-rprx-vision</option>
        </select>
      </Field>
    );

    const vmessSecurity = kind === "vmess" && (
      <Field label={t("sockscap.vmessSecurity")}>
        <select
          className={cls}
          value={p.security || "auto"}
          onChange={(e) => void patchUpstreamParams({ security: e.target.value })}
        >
          <option value="auto">auto</option>
          <option value="aes-128-gcm">aes-128-gcm</option>
          <option value="chacha20-poly1305">chacha20-poly1305</option>
          <option value="none">none</option>
        </select>
      </Field>
    );

    return (
      // A disabled <fieldset> natively disables every descendant control;
      // `display:contents` keeps the parent grid layout intact. Lets us lock the
      // whole protocol-params block while running without touching each field.
      <fieldset
        disabled={locked}
        className="contents"
        title={locked ? t("sockscap.lockedTooltip") : undefined}
      >
        {kind === "shadowsocks" && (
          <Field label={t("sockscap.ssMethod")}>
            <select
              className={cls}
              value={p.method || "aes-256-gcm"}
              onChange={(e) => void patchUpstreamParams({ method: e.target.value })}
            >
              <option value="aes-256-gcm">aes-256-gcm</option>
              <option value="aes-128-gcm">aes-128-gcm</option>
              <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
              <option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option>
              <option value="2022-blake3-chacha20-poly1305">
                2022-blake3-chacha20-poly1305
              </option>
            </select>
          </Field>
        )}
        {(kind === "vmess" || kind === "vless") && uuidField}
        {vmessSecurity}
        {vlessFlow}
        {transportFields}
        {tlsFields}
        {wgFields}
      </fieldset>
    );
  };
  return { renderCoreParams };
}
