import { Shield } from "lucide-react";
import { type Proto } from "./sessionPolicy";
import { Field, Select, Checkbox } from "./Fields";


/* ------------------------------------------------------------------ */
/*  Database settings sub-form                                         */
/* ------------------------------------------------------------------ */

export function DatabaseSettings({
  proto,
  username, setUsername,
  password, setPassword,
  passwordRef, clearPasswordRef,
  saveInVault, setSaveInVault,
  vaultState,
  catalog, setCatalog,
  database, setDatabase,
  ssl, setSsl,
  timeoutSecs, setTimeoutSecs,
  httpPort, setHttpPort,
  chProtocol, setChProtocol,
  prestoDialect, setPrestoDialect,
  redisDbIndex, setRedisDbIndex,
}: {
  proto: Proto;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string; clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
  catalog: string; setCatalog: (v: string) => void;
  database: string; setDatabase: (v: string) => void;
  ssl: boolean; setSsl: (v: boolean) => void;
  timeoutSecs: string; setTimeoutSecs: (v: string) => void;
  httpPort: string; setHttpPort: (v: string) => void;
  chProtocol: string; setChProtocol: (v: string) => void;
  /** "Presto" | "Trino" — controls X-Presto-* vs X-Trino-* headers. */
  prestoDialect: string; setPrestoDialect: (v: string) => void;
  redisDbIndex: string; setRedisDbIndex: (v: string) => void;
}) {
  const isRedis = proto === "Redis";
  const isClickHouse = proto === "ClickHouse";
  const isPresto = proto === "Presto";
  const isOracle = proto === "Oracle";
  return (
    <div data-testid="database-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Username">
        <input
          className="taomni-input w-64"
          value={username}
          aria-label="Database username"
          placeholder={isRedis ? "(optional — ACL user)" : "database user"}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>

      <Field label="Password">
          <input
            className="taomni-input w-64"
            type="password"
            value={password}
            aria-label="Database password"
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
            data-testid="db-save-in-vault"
            checked={saveInVault}
            onChange={(e) => setSaveInVault(e.target.checked)}
          />
          Save in vault
        </label>
        <span className="taomni-pill">
          <Shield className="w-3 h-3" /> Encrypted
        </span>
      </Field>

      {isPresto && (
        <Field label="Engine">
          <Select
            value={prestoDialect}
            className="w-40"
            options={["Presto", "Trino"]}
            onChange={setPrestoDialect}
            ariaLabel="Presto/Trino engine"
          />
          <span className="ml-2 text-[var(--taomni-text-muted)]">
            Trino uses X-Trino-* headers
          </span>
        </Field>
      )}

      {isPresto && (
        <Field label="Catalog">
          <input
            className="taomni-input w-64"
            value={catalog}
            aria-label="Presto catalog"
            placeholder="hive / tpch / system"
            onChange={(e) => setCatalog(e.target.value)}
          />
        </Field>
      )}

      {!isRedis && (
        <Field label={isPresto ? "Schema" : isOracle ? "Service / Schema" : "Database"}>
          <input
            className="taomni-input w-64"
            value={database}
            aria-label={isPresto ? "Presto schema" : isOracle ? "Oracle service or schema" : "Database name"}
            placeholder={isPresto ? "(optional) default schema" : isOracle ? "service name (e.g. ORCLPDB1)" : "database / schema name"}
            onChange={(e) => setDatabase(e.target.value)}
          />
        </Field>
      )}

      {isRedis && (
        <>
          <Field label="DB index">
            <input
              className="taomni-input w-20"
              type="number"
              min={0}
              max={15}
              value={redisDbIndex}
              aria-label="Redis DB index"
              onChange={(e) => setRedisDbIndex(e.target.value)}
            />
            <span className="ml-2 text-[var(--taomni-text-muted)]">0–15</span>
          </Field>
          <Field label="Key prefix">
            <input
              className="taomni-input w-64"
              value={database}
              aria-label="Redis key prefix"
              placeholder="(optional) default SCAN prefix"
              onChange={(e) => setDatabase(e.target.value)}
            />
          </Field>
        </>
      )}

      {isClickHouse && (
        <>
          <Field label="HTTP port">
            <input
              className="taomni-input w-24"
              value={httpPort}
              aria-label="ClickHouse HTTP port"
              placeholder="8123"
              onChange={(e) => setHttpPort(e.target.value)}
            />
          </Field>
          <Field label="Protocol">
            <Select
              value={chProtocol}
              className="w-40"
              options={["HTTP", "Native"]}
              onChange={setChProtocol}
            />
          </Field>
        </>
      )}

      <Field label="SSL / TLS">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={ssl} onChange={setSsl} />
          Use encrypted connection
        </label>
      </Field>

      <Field label="Timeout">
        <input
          className="taomni-input w-20"
          value={timeoutSecs}
          aria-label="Connection timeout seconds"
          onChange={(e) => setTimeoutSecs(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">seconds</span>
      </Field>
    </div>
  );
}
