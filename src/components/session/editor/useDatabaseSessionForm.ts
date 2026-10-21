import { useState } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import { optionString, optionBoolean } from "./sessionPolicy";


export interface UseDatabaseSessionFormContext {
  initialOptions: Record<string, unknown>;
  session: SessionConfig | undefined;
}

export function useDatabaseSessionForm(context: UseDatabaseSessionFormContext) {
  const { initialOptions, session } = context;

  /* --- database session options (MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto/Redis) --- */
  const [dbCatalog, setDbCatalog] = useState(() => optionString(initialOptions, "dbCatalog", ""));
  const [dbDatabase, setDbDatabase] = useState(() => optionString(initialOptions, "dbDatabase", ""));
  const [dbSsl, setDbSsl] = useState(() => optionBoolean(initialOptions, "dbSsl", false));
  const [dbTimeout, setDbTimeout] = useState(() => optionString(initialOptions, "dbTimeout", "15"));
  const [dbHttpPort, setDbHttpPort] = useState(() => optionString(initialOptions, "dbHttpPort", "8123"));
  const [dbChProtocol, setDbChProtocol] = useState(() => optionString(initialOptions, "dbChProtocol", "HTTP"));
  // New sessions default to Trino (modern default); saved sessions without the
  // key hydrate as "Presto" so legacy options_json keeps X-Presto-* behavior.
  const [dbPrestoDialect, setDbPrestoDialect] = useState(() => {
    const stored = optionString(initialOptions, "dbPrestoDialect", "");
    if (stored.toLowerCase() === "trino") return "Trino";
    if (stored.toLowerCase() === "presto") return "Presto";
    return session ? "Presto" : "Trino";
  });
  const [dbRedisIndex, setDbRedisIndex] = useState(() => optionString(initialOptions, "dbRedisIndex", "0"));
  const [hbaseNamespace, setHBaseNamespace] = useState(() => optionString(initialOptions, "hbaseNamespace", ""));
  const [hbaseRestPath, setHBaseRestPath] = useState(() => optionString(initialOptions, "hbaseRestPath", ""));
  const [hbaseConnectionMode, setHBaseConnectionMode] = useState(() => optionString(initialOptions, "hbaseConnectionMode", "native"));
  const [hbaseZkQuorum, setHBaseZkQuorum] = useState(() => optionString(initialOptions, "hbaseZkQuorum", ""));
  const [hbaseZkRoot, setHBaseZkRoot] = useState(() => optionString(initialOptions, "hbaseZkRoot", ""));
  const [hbaseEffectiveUser, setHBaseEffectiveUser] = useState(() => optionString(initialOptions, "hbaseEffectiveUser", ""));
  const [hbaseAuthMethod, setHBaseAuthMethod] = useState(() => optionString(initialOptions, "hbaseAuthMethod", "simple"));
  const [hbaseServicePrincipal, setHBaseServicePrincipal] = useState(() => optionString(initialOptions, "hbaseServicePrincipal", ""));
  const [hbasePrincipal, setHBasePrincipal] = useState(() => optionString(initialOptions, "hbasePrincipal", ""));
  const [hbaseKeytabPath, setHBaseKeytabPath] = useState(() => optionString(initialOptions, "hbaseKeytabPath", ""));
  const [hbaseKrb5ConfPath, setHBaseKrb5ConfPath] = useState(() => optionString(initialOptions, "hbaseKrb5ConfPath", ""));
  const [hbaseSitePath, setHBaseSitePath] = useState(() => optionString(initialOptions, "hbaseSitePath", ""));
  return { dbDatabase, dbCatalog, dbSsl, dbTimeout, dbHttpPort, dbChProtocol, dbPrestoDialect, dbRedisIndex, hbaseNamespace, hbaseRestPath, hbaseConnectionMode, hbaseZkQuorum, hbaseZkRoot, hbaseEffectiveUser, hbaseAuthMethod, hbaseServicePrincipal, hbasePrincipal, hbaseKeytabPath, hbaseKrb5ConfPath, hbaseSitePath, setDbCatalog, setDbDatabase, setDbSsl, setDbTimeout, setDbHttpPort, setDbChProtocol, setDbPrestoDialect, setDbRedisIndex, setHBaseNamespace, setHBaseRestPath, setHBaseConnectionMode, setHBaseZkQuorum, setHBaseZkRoot, setHBaseEffectiveUser, setHBaseAuthMethod, setHBaseServicePrincipal, setHBasePrincipal, setHBaseKeytabPath, setHBaseKrb5ConfPath, setHBaseSitePath };
}
