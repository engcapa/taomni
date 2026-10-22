import { Shield, FileText, Info } from "lucide-react";
import { selectFilePath, hbaseParseSiteXml, hbaseParseKeytabPrincipal } from "../../../lib/ipc";
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

  const handleBrowseSiteXml = async () => {
    try {
      const selected = await selectFilePath(hbaseSitePath || undefined);
      if (selected) setHBaseSitePath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleBrowseKeytab = async () => {
    try {
      const selected = await selectFilePath(keytabPath || undefined);
      if (selected) setKeytabPath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleBrowseKrb5Conf = async () => {
    try {
      const selected = await selectFilePath(krb5ConfPath || undefined);
      if (selected) setKrb5ConfPath(selected.trim());
    } catch (err) {
      alert("Failed to choose file: " + err);
    }
  };

  const handleAnalyzeSiteXml = async () => {
    if (!hbaseSitePath.trim()) return;
    try {
      const props = await hbaseParseSiteXml(hbaseSitePath.trim());
      if (props["hbase.zookeeper.quorum"]) {
        setZkQuorum(props["hbase.zookeeper.quorum"]);
      }
      if (props["zookeeper.znode.parent"]) {
        setZkRoot(props["zookeeper.znode.parent"]);
      }
      if (props["hbase.regionserver.kerberos.principal"] || props["hbase.master.kerberos.principal"]) {
        setServicePrincipal(props["hbase.regionserver.kerberos.principal"] || props["hbase.master.kerberos.principal"]);
      }
    } catch (err) {
      alert("Failed to parse hbase-site.xml: " + err);
    }
  };

  const handleAnalyzeKeytab = async () => {
    if (!keytabPath.trim()) return;
    try {
      const parsedPrincipal = await hbaseParseKeytabPrincipal(keytabPath.trim());
      if (parsedPrincipal) {
        setPrincipal(parsedPrincipal);
      }
    } catch (err) {
      alert("Failed to parse keytab: " + err);
    }
  };

  return (
    <div data-testid="hbase-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
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
          <option value="thrift">Thrift2 (Lindorm / HBase 增强版, 9190)</option>
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
            <input
              className="taomni-input w-96 min-w-0"
              value={hbaseSitePath}
              aria-label="HBase site config file path"
              placeholder="(optional) /etc/hbase/conf/hbase-site.xml"
              onChange={(e) => setHBaseSitePath(e.target.value)}
            />
            <button
              type="button"
              className="taomni-btn px-2 shrink-0 py-1"
              title="Browse file"
              onClick={handleBrowseSiteXml}
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="taomni-btn px-2 shrink-0 py-1"
              title="Auto-analyze hbase-site.xml and populate fields"
              disabled={!hbaseSitePath.trim()}
              onClick={handleAnalyzeSiteXml}
            >
              Analyze
            </button>
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
                <input
                  className="taomni-input w-96 min-w-0"
                  data-testid="hbase-keytab-path"
                  aria-label="HBase keytab file path"
                  value={keytabPath}
                  placeholder="(optional) /etc/security/keytabs/user.keytab"
                  onChange={(e) => setKeytabPath(e.target.value)}
                />
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Browse file"
                  onClick={handleBrowseKeytab}
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Auto-analyze keytab and extract principal"
                  disabled={!keytabPath.trim()}
                  onClick={handleAnalyzeKeytab}
                >
                  Parse
                </button>
                <span className="w-full text-[var(--taomni-text-muted)] mt-0.5 pl-1 block">
                  Auto-authenticates using keytab on connect.
                </span>
              </Field>
              <Field label="Krb5 config path">
                <input
                  className="taomni-input w-96 min-w-0"
                  data-testid="hbase-krb5-conf-path"
                  aria-label="HBase krb5 config file path"
                  value={krb5ConfPath}
                  placeholder="(optional) /etc/krb5.conf"
                  onChange={(e) => setKrb5ConfPath(e.target.value)}
                />
                <button
                  type="button"
                  className="taomni-btn px-2 shrink-0 py-1"
                  title="Browse file"
                  onClick={handleBrowseKrb5Conf}
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
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
                <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-1.5 pl-1">
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
          className="flex items-center gap-1 text-[11px] cursor-pointer ml-2"
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
