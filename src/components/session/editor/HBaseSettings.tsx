import { SessionFilePathInput } from "./SessionFilePathInput";
import { useT } from "../../../lib/i18n";
import { Shield, Info } from "lucide-react";
import { hbaseParseSiteXml, hbaseParseKeytabPrincipal } from "../../../lib/ipc";
import { Field, Checkbox } from "./Fields";


export function HBaseSettings({
  host, setHost,
  port, setPort,
  username, setUsername,
  password, setPassword,
  passwordRef, clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  namespace, setNamespace,
  restPath, setRestPath,
  connectionMode, setConnectionMode,
  zkQuorum, setZkQuorum,
  zkRoot, setZkRoot,
  effectiveUser, setEffectiveUser,
  ssl, setSsl,
  timeoutSecs, setTimeoutSecs,
  authMethod, setAuthMethod,
  servicePrincipal, setServicePrincipal,
  principal, setPrincipal,
  keytabPath, setKeytabPath,
  krb5ConfPath, setKrb5ConfPath,
  hbaseSitePath, setHBaseSitePath,
}: {
  host: string; setHost: (v: string) => void;
  port: string; setPort: (v: string) => void;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string; clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  namespace: string; setNamespace: (v: string) => void;
  restPath: string; setRestPath: (v: string) => void;
  connectionMode: string; setConnectionMode: (v: string) => void;
  zkQuorum: string; setZkQuorum: (v: string) => void;
  zkRoot: string; setZkRoot: (v: string) => void;
  effectiveUser: string; setEffectiveUser: (v: string) => void;
  ssl: boolean; setSsl: (v: boolean) => void;
  timeoutSecs: string; setTimeoutSecs: (v: string) => void;
  authMethod: string; setAuthMethod: (v: string) => void;
  servicePrincipal: string; setServicePrincipal: (v: string) => void;
  principal: string; setPrincipal: (v: string) => void;
  keytabPath: string; setKeytabPath: (v: string) => void;
  krb5ConfPath: string; setKrb5ConfPath: (v: string) => void;
  hbaseSitePath: string; setHBaseSitePath: (v: string) => void;
}) {
  const isThrift = connectionMode === "thrift";
  const isRest = connectionMode === "rest";
  const isNative = !isThrift && !isRest;
  // REST and Thrift both connect to an explicit host:port endpoint.
  const showHostPort = !isNative;

  const t = useT();
  async function readSiteConfig(path: string) {
    const properties = await hbaseParseSiteXml(path);
    const quorum = properties["hbase.zookeeper.quorum"];
    const root = properties["zookeeper.znode.parent"];
    const principal = properties["hbase.regionserver.kerberos.principal"] || properties["hbase.master.kerberos.principal"];
    return () => {
      if (quorum) setZkQuorum(quorum);
      if (root) setZkRoot(root);
      if (principal) setServicePrincipal(principal);
    };
  }

  async function readKeytab(path: string) {
    const principal = await hbaseParseKeytabPrincipal(path);
    return () => { if (principal) setPrincipal(principal); };
  }

  return (
    <div data-testid="hbase-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-ui-body">
      <Field label="Mode">
        <select
          className="taomni-input w-64"
          data-testid="hbase-connection-mode"
          aria-label="HBase connection mode"
          value={isThrift ? "thrift" : isRest ? "rest" : "native"}
          onChange={(e) => {
            const next = e.target.value;
            setConnectionMode(next);
            // Suggest the Lindorm Thrift default port when entering thrift mode
            // from an unset/REST default port.
            if (next === "thrift" && (!port.trim() || port.trim() === "8080")) {
              setPort("9190");
            }
          }}
        >
          <option value="native">Native RPC (ZooKeeper + RegionServer)</option>
          <option value="rest">REST / Stargate gateway</option>
          <option value="thrift">{t("sessionEditor2.hbaseThriftMode")}</option>
        </select>
        <span className="ml-2 text-[var(--taomni-text-muted)]">
          {isNative
            ? "No gateway needed; talks the native protocol."
            : isThrift
              ? "Aliyun Lindorm Thrift2-over-HTTP; uses AccessKey/Signature."
              : "Requires an HBase REST server."}
        </span>
      </Field>

      {/* host/port are the REST/Thrift endpoint. Native mode bootstraps via the
          ZK quorum (or hbase-site.xml), so these are hidden there. */}
      {showHostPort && (
        <>
          <Field label="Remote host">
            <input
              className="taomni-input w-64"
              value={host}
              aria-label="Remote host"
              placeholder={isThrift ? "e.g. ld-xxxx-proxy-lindorm.lindorm.aliyuncs.com" : "e.g. hbase-rest.example.com"}
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          <Field label="Port">
            <input
              className="taomni-input w-32"
              value={port}
              aria-label="HBase endpoint port"
              placeholder={isThrift ? "9190" : "8080"}
              onChange={(e) => setPort(e.target.value)}
            />
          </Field>
        </>
      )}

      {isNative && (
        <>
          <Field label="HBase-site.xml path">
            <SessionFilePathInput value={hbaseSitePath} onChange={setHBaseSitePath}
              label="HBase site config file path" placeholder="(optional) /etc/hbase/conf/hbase-site.xml"
              analysis={{ label: t("sessionEditor2.analyzeSite"), title: t("sessionEditor2.analyzeSiteHint"), read: readSiteConfig }} />
          </Field>
          <Field label="ZK quorum">
            <input
              className="taomni-input w-64"
              value={zkQuorum}
              aria-label="HBase ZooKeeper quorum"
              placeholder="(optional) zk1:2181,zk2:2181 — defaults to host:port"
              onChange={(e) => setZkQuorum(e.target.value)}
            />
          </Field>
          <Field label="ZK root">
            <input
              className="taomni-input w-64"
              value={zkRoot}
              aria-label="HBase ZooKeeper root"
              placeholder="(optional) /hbase"
              onChange={(e) => setZkRoot(e.target.value)}
            />
          </Field>
          <Field label="Effective user">
            <input
              className="taomni-input w-64"
              value={effectiveUser}
              aria-label="HBase effective user"
              placeholder="(optional) defaults to root"
              onChange={(e) => setEffectiveUser(e.target.value)}
            />
          </Field>
          <Field label="Auth method">
            <select
              className="taomni-input w-64"
              data-testid="hbase-auth-method"
              aria-label="HBase auth method"
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value)}
            >
              <option value="simple">Simple (effective user only)</option>
              <option value="kerberos">Kerberos (GSSAPI)</option>
            </select>
          </Field>

          {authMethod === "kerberos" && (
            <>
              <Field label="Service principal">
                <input
                  className="taomni-input w-64"
                  data-testid="hbase-service-principal"
                  aria-label="HBase service principal"
                  value={servicePrincipal}
                  placeholder="hbase/_HOST@REALM"
                  onChange={(e) => setServicePrincipal(e.target.value)}
                />
              </Field>
              <Field label="Keytab path">
                <SessionFilePathInput value={keytabPath} onChange={setKeytabPath} testId="hbase-keytab-path"
                  label="HBase keytab file path" placeholder="(optional) /etc/security/keytabs/user.keytab"
                  analysis={{ label: t("sessionEditor2.parseKeytab"), title: t("sessionEditor2.parseKeytabHint"), read: readKeytab }} />
                <span className="w-full text-[var(--taomni-text-muted)] mt-0.5 pl-1 block">
                  Auto-authenticates using keytab on connect.
                </span>
              </Field>
              <Field label="Krb5 config path">
                <SessionFilePathInput value={krb5ConfPath} onChange={setKrb5ConfPath} testId="hbase-krb5-conf-path"
                  label="HBase krb5 config file path" placeholder="(optional) /etc/krb5.conf" />
              </Field>
              {keytabPath.trim() && (
                <Field label="Principal">
                  <input
                    className="taomni-input w-64"
                    data-testid="hbase-principal"
                    aria-label="HBase client principal"
                    value={principal}
                    placeholder="user@EXAMPLE.COM"
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                </Field>
              )}
              {!keytabPath.trim() && (
                <div className="col-span-12 text-ui-small text-[var(--taomni-text-muted)] flex items-center gap-1.5 pl-1">
                  <Info className="w-3 h-3 shrink-0" />
                  No keytab configured. Run <code className="taomni-mono">kinit</code> manually before connecting.
                </div>
              )}
            </>
          )}
        </>
      )}

      <Field label={isThrift ? "AccessKeyId" : "Username"}>
        <input
          className="taomni-input w-64"
          value={username}
          aria-label="HBase username"
          placeholder={isThrift ? "(optional) ACL AccessKeyId" : "(optional) REST basic auth user"}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>

      <Field label={isThrift ? "AccessKeySignature" : "Password"}>
          <input
            className="taomni-input w-64"
            type="password"
            value={password}
            aria-label="HBase password"
            placeholder={passwordRef ? "•••••• (saved in vault)" : ""}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordRef) clearPasswordRef();
            }}
          />
        <label
          className="flex items-center gap-1 text-ui-small cursor-pointer ml-2"
          title={vaultState === "empty" ? "Set up the vault on save to store passwords" : "Encrypt and store this password in the vault"}
        >
          <input
            type="checkbox"
            className="taomni-checkbox"
            data-testid="hbase-save-in-vault"
            checked={saveInVault}
            onChange={(e) => setSaveInVault(e.target.checked)}
          />
          Save in vault
        </label>
        <span className="taomni-pill">
          <Shield className="w-3 h-3" /> Encrypted
        </span>
      </Field>

      <Field label="Namespace">
        <input
          className="taomni-input w-64"
          value={namespace}
          aria-label="HBase namespace"
          placeholder="(optional) default namespace"
          onChange={(e) => setNamespace(e.target.value)}
        />
      </Field>

      {isRest && (
        <Field label="REST path">
          <input
            className="taomni-input w-64"
            value={restPath}
            aria-label="HBase REST path"
            placeholder="(optional) gateway prefix"
            onChange={(e) => setRestPath(e.target.value)}
          />
          <span className="ml-2 text-[var(--taomni-text-muted)]">Leave empty for Stargate root.</span>
        </Field>
      )}

      <Field label="SSL / TLS">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={ssl} onChange={setSsl} />
          Use HTTPS
        </label>
      </Field>

      <Field label="Timeout">
        <input
          className="taomni-input w-20"
          value={timeoutSecs}
          aria-label="HBase timeout seconds"
          onChange={(e) => setTimeoutSecs(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">seconds</span>
      </Field>
    </div>
  );
}
