import { useState } from "react";
import {
  PROVIDER_PRESETS,
  presetFor,
  engineForProvider,
  type ObjectStorageConfig,
  type ObjectStorageProvider,
  type AwsAuthSource,
  type AzureAuthSource,
} from "../../types/objectStorage";
import { storageTestConnection } from "../../lib/objectStorage";
import { parseSessionOptions } from "../../lib/terminalProfile";

/** Editor-local form state for an object-storage connection. Secrets are kept
 * as plaintext while editing; the save path swaps them for `vault:` refs. */
export interface OssFormState {
  provider: ObjectStorageProvider;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  defaultBucket: string;
  /** S3 credential source. */
  awsAuth: AwsAuthSource;
  awsProfile: string;
  accountName: string;
  accountKey: string;
  connectionString: string;
  sasToken: string;
  endpointSuffix: string;
  defaultContainer: string;
  /** Azure auth source. */
  azureAuth: AzureAuthSource;
  azureBearerToken: string;
  /** Default storage class / access tier for uploads. */
  storageClass: string;
}

export function emptyOssForm(): OssFormState {
  return {
    provider: "aws",
    endpoint: "",
    region: "",
    pathStyle: false,
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    defaultBucket: "",
    awsAuth: "keys",
    awsProfile: "",
    accountName: "",
    accountKey: "",
    connectionString: "",
    sasToken: "",
    endpointSuffix: "",
    defaultContainer: "",
    azureAuth: "key",
    azureBearerToken: "",
    storageClass: "",
  };
}

/** Hydrate the form from a session's options_json. */
export function ossFormFromOptions(optionsJson: string | null | undefined): OssFormState {
  const o = parseSessionOptions(optionsJson);
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const provider = (s("provider") as ObjectStorageProvider) || "aws";
  const awsAuthRaw = s("awsAuth");
  const awsAuth: AwsAuthSource =
    awsAuthRaw === "environment" || awsAuthRaw === "profile" ? awsAuthRaw : "keys";
  const azureAuthRaw = s("azureAuth");
  const azureAuth: AzureAuthSource =
    azureAuthRaw === "sas" || azureAuthRaw === "connstr" || azureAuthRaw === "bearer"
      ? azureAuthRaw
      : "key";
  return {
    provider: PROVIDER_PRESETS.some((p) => p.id === provider) ? provider : "aws",
    endpoint: s("endpoint"),
    region: s("region"),
    pathStyle: typeof o.pathStyle === "boolean" ? o.pathStyle : presetFor(provider).pathStyle ?? false,
    accessKeyId: s("accessKeyId"),
    secretAccessKey: s("secretAccessKey"),
    sessionToken: s("sessionToken"),
    defaultBucket: s("defaultBucket"),
    awsAuth,
    awsProfile: s("awsProfile"),
    accountName: s("accountName"),
    accountKey: s("accountKey"),
    connectionString: s("connectionString"),
    sasToken: s("sasToken"),
    endpointSuffix: s("endpointSuffix"),
    defaultContainer: s("defaultContainer"),
    azureAuth,
    azureBearerToken: s("azureBearerToken"),
    storageClass: s("storageClass"),
  };
}

/** Build the wire config from form state (secrets as-is — plaintext or refs). */
export function ossFormToConfig(f: OssFormState): ObjectStorageConfig {
  const isAzure = engineForProvider(f.provider) === "azure";
  return {
    provider: f.provider,
    endpoint: f.endpoint || null,
    region: f.region || null,
    pathStyle: f.pathStyle,
    accessKeyId: f.accessKeyId || null,
    secretAccessKey: f.secretAccessKey || null,
    sessionToken: f.sessionToken || null,
    defaultBucket: f.defaultBucket || null,
    awsAuth: !isAzure ? f.awsAuth : null,
    awsProfile: !isAzure && f.awsAuth === "profile" ? f.awsProfile || null : null,
    accountName: f.accountName || null,
    accountKey: f.accountKey || null,
    connectionString: f.connectionString || null,
    sasToken: f.sasToken || null,
    endpointSuffix: f.endpointSuffix || null,
    defaultContainer: f.defaultContainer || null,
    azureAuth: isAzure ? f.azureAuth : null,
    azureBearerToken: isAzure && f.azureAuth === "bearer" ? f.azureBearerToken || null : null,
    storageClass: f.storageClass || null,
  };
}

// PLACEHOLDER_FORM_COMPONENT

interface ObjectStorageSettingsProps {
  value: OssFormState;
  onChange: (next: OssFormState) => void;
  saveInVault: boolean;
  setSaveInVault: (v: boolean) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

export function ObjectStorageSettings({ value, onChange, saveInVault, setSaveInVault }: ObjectStorageSettingsProps) {
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const engine = engineForProvider(value.provider);
  const preset = presetFor(value.provider);
  const patch = (p: Partial<OssFormState>) => onChange({ ...value, ...p });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await storageTestConnection(ossFormToConfig(value));
      setTest({ ok: true, msg: "Connection succeeded." });
    } catch (err) {
      setTest({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const input = "taomni-input w-full";

  return (
    <div data-testid="session-objectstorage-section" className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[12px]">
      <Row label="Provider">
        <select
          className={input}
          value={value.provider}
          onChange={(e) => {
            const provider = e.target.value as ObjectStorageProvider;
            patch({ provider, pathStyle: presetFor(provider).pathStyle ?? false });
          }}
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Row>

      {engine === "s3" ? (
        <>
          <Row label={preset.endpointDerived ? "Region (endpoint derived)" : "Region"}>
            <input className={input} value={value.region} placeholder="us-east-1" onChange={(e) => patch({ region: e.target.value })} />
          </Row>
          {!preset.endpointDerived && (
            <Row label="Endpoint">
              <input className={input} value={value.endpoint} placeholder={preset.endpointHint} onChange={(e) => patch({ endpoint: e.target.value })} />
            </Row>
          )}
          <Row label="Authentication">
            <select className={input} value={value.awsAuth} onChange={(e) => patch({ awsAuth: e.target.value as AwsAuthSource })}>
              <option value="keys">Access keys</option>
              <option value="environment">Environment variables (AWS_*)</option>
              <option value="profile">Shared profile (~/.aws)</option>
            </select>
          </Row>
          {value.awsAuth === "keys" && (
            <>
              <Row label="Access key ID">
                <input className={input} value={value.accessKeyId} autoComplete="off" onChange={(e) => patch({ accessKeyId: e.target.value })} />
              </Row>
              <Row label="Secret access key">
                <input className={input} type="password" value={value.secretAccessKey} autoComplete="off" onChange={(e) => patch({ secretAccessKey: e.target.value })} />
              </Row>
              <Row label="Session token (optional)">
                <input className={input} type="password" value={value.sessionToken} autoComplete="off" onChange={(e) => patch({ sessionToken: e.target.value })} />
              </Row>
            </>
          )}
          {value.awsAuth === "profile" && (
            <Row label="Profile name (blank = AWS_PROFILE / default)">
              <input className={input} value={value.awsProfile} placeholder="default" autoComplete="off" onChange={(e) => patch({ awsProfile: e.target.value })} />
            </Row>
          )}
          {value.awsAuth === "environment" && (
            <p className="col-span-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              Uses AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN) from the app's environment at connect time.
            </p>
          )}
          {value.awsAuth === "profile" && (
            <p className="col-span-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              Reads ~/.aws/credentials and ~/.aws/config. SSO / assume-role / instance-role profiles are resolved via the AWS CLI (<code>aws configure export-credentials</code>).
            </p>
          )}
          <Row label="Default bucket (optional)">
            <input className={input} value={value.defaultBucket} onChange={(e) => patch({ defaultBucket: e.target.value })} />
          </Row>
          <Row label="Default storage class (optional)">
            <input className={input} list="oss-s3-classes" value={value.storageClass} placeholder="STANDARD" onChange={(e) => patch({ storageClass: e.target.value })} />
            <datalist id="oss-s3-classes">
              <option value="STANDARD" />
              <option value="STANDARD_IA" />
              <option value="ONEZONE_IA" />
              <option value="INTELLIGENT_TIERING" />
              <option value="GLACIER" />
              <option value="GLACIER_IR" />
              <option value="DEEP_ARCHIVE" />
            </datalist>
          </Row>
          <label className="flex items-center gap-2 col-span-2">
            <input type="checkbox" checked={value.pathStyle} onChange={(e) => patch({ pathStyle: e.target.checked })} />
            <span>Force path-style addressing (required by MinIO / Ceph)</span>
          </label>
        </>
      ) : (
        <>
          <Row label="Account name">
            <input className={input} value={value.accountName} onChange={(e) => patch({ accountName: e.target.value })} />
          </Row>
          <Row label="Endpoint suffix (optional)">
            <input className={input} value={value.endpointSuffix} placeholder="core.windows.net" onChange={(e) => patch({ endpointSuffix: e.target.value })} />
          </Row>
          <Row label="Authentication">
            <select className={input} value={value.azureAuth} onChange={(e) => patch({ azureAuth: e.target.value as AzureAuthSource })}>
              <option value="key">Account key</option>
              <option value="sas">SAS token</option>
              <option value="connstr">Connection string</option>
              <option value="bearer">Entra ID (Azure AD)</option>
            </select>
          </Row>
          {value.azureAuth === "key" && (
            <Row label="Account key">
              <input className={input} type="password" value={value.accountKey} autoComplete="off" onChange={(e) => patch({ accountKey: e.target.value })} />
            </Row>
          )}
          {value.azureAuth === "sas" && (
            <Row label="SAS token">
              <input className={input} type="password" value={value.sasToken} autoComplete="off" onChange={(e) => patch({ sasToken: e.target.value })} />
            </Row>
          )}
          {value.azureAuth === "connstr" && (
            <Row label="Connection string">
              <input className={input} type="password" value={value.connectionString} autoComplete="off" onChange={(e) => patch({ connectionString: e.target.value })} />
            </Row>
          )}
          {value.azureAuth === "bearer" && (
            <>
              <Row label="Access token (optional — blank uses Azure CLI)">
                <input className={input} type="password" value={value.azureBearerToken} autoComplete="off" onChange={(e) => patch({ azureBearerToken: e.target.value })} />
              </Row>
              <p className="col-span-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                Leave blank to obtain a token from the Azure CLI (<code>az account get-access-token</code>; run <code>az login</code> first). Share links (SAS) are unavailable with Entra ID auth.
              </p>
            </>
          )}
          <Row label="Default container (optional)">
            <input className={input} value={value.defaultContainer} onChange={(e) => patch({ defaultContainer: e.target.value })} />
          </Row>
          <Row label="Default access tier (optional)">
            <input className={input} list="oss-azure-tiers" value={value.storageClass} placeholder="Hot" onChange={(e) => patch({ storageClass: e.target.value })} />
            <datalist id="oss-azure-tiers">
              <option value="Hot" />
              <option value="Cool" />
              <option value="Cold" />
              <option value="Archive" />
            </datalist>
          </Row>
        </>
      )}

      <label className="flex items-center gap-2 col-span-2">
        <input type="checkbox" checked={saveInVault} onChange={(e) => setSaveInVault(e.target.checked)} />
        <span>Save secrets in vault (recommended)</span>
      </label>

      <div className="col-span-2 flex items-center gap-3">
        <button type="button" className="taomni-btn" disabled={testing} onClick={() => void runTest()}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        {test && (
          <span className="text-[11px]" style={{ color: test.ok ? "var(--taomni-accent)" : "#d33" }}>
            {test.msg}
          </span>
        )}
      </div>
    </div>
  );
}

