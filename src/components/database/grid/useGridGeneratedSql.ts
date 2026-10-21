import { useState, useEffect, useMemo } from "react";
import type { DbResultSqlRewriteRequest } from "../../../lib/ipc";
import { dbRewriteResultSql } from "../../../lib/ipc";
import { writeText } from "../../../lib/clipboard";
import { getActiveQueryTab, listQueryTabs } from "../../../lib/queryRegistry";
import { type SortRule, type ResolvedGeneratedSql, type ActiveColumnFilter, type QueryGeneratedSqlSyncMode } from "./types";
import { buildGeneratedResultSql, buildResultSqlRewriteRequest, resultSqlRewriteKey, compactSqlForDisplay } from "./generatedSql";


export interface UseGridGeneratedSqlContext {
  baseSql: string | undefined;
  sourceSql: string | undefined;
  sqlEngine: string | undefined;
  result: import("../../../lib/ipc").DbQueryResult;
  visibleColumnIndexes: number[];
  filterText: string;
  activeColumnFilters: ActiveColumnFilter[];
  sorts: SortRule[];
  setLocalNotice: import("react").Dispatch<import("react").SetStateAction<string>>;
  setStatus: (message: string) => void;
  onGeneratedSqlQuery: ((sql: string, request?: DbResultSqlRewriteRequest) => void | Promise<void>) | undefined;
  onGeneratedSqlSync: ((sql: string, mode: QueryGeneratedSqlSyncMode) => void) | undefined;
}

export function useGridGeneratedSql(context: UseGridGeneratedSqlContext) {
  const {
    baseSql,
    sourceSql,
    sqlEngine,
    result,
    visibleColumnIndexes,
    filterText,
    activeColumnFilters,
    sorts,
    setLocalNotice,
    setStatus,
    onGeneratedSqlQuery,
    onGeneratedSqlSync,
  } = context;

  const [resolvedGeneratedSql, setResolvedGeneratedSql] = useState<ResolvedGeneratedSql | null>(null);

  const generatedSql = useMemo(
    () =>
      buildGeneratedResultSql({
        sourceSql: baseSql ?? sourceSql,
        currentSql: sourceSql,
        sqlEngine,
        columns: result.columns,
        visibleColumnIndexes,
        globalFilterText: filterText,
        columnFilters: activeColumnFilters,
        sorts,
      }),
    [activeColumnFilters, baseSql, filterText, result.columns, sorts, sourceSql, sqlEngine, visibleColumnIndexes],
  );
  const generatedSqlRewriteRequest = useMemo(
    () =>
      buildResultSqlRewriteRequest({
        sourceSql: baseSql ?? sourceSql,
        currentSql: sourceSql,
        sqlEngine,
        columns: result.columns,
        visibleColumnIndexes,
        globalFilterText: filterText,
        columnFilters: activeColumnFilters,
        sorts,
      }),
    [activeColumnFilters, baseSql, filterText, result.columns, sorts, sourceSql, sqlEngine, visibleColumnIndexes],
  );
  const generatedSqlRewriteKey = useMemo(
    () => resultSqlRewriteKey(generatedSqlRewriteRequest),
    [generatedSqlRewriteRequest],
  );

  useEffect(() => {
    if (!generatedSql || !generatedSqlRewriteRequest || !generatedSqlRewriteKey) {
      setResolvedGeneratedSql(null);
      return;
    }
    let cancelled = false;
    setResolvedGeneratedSql((current) =>
      current?.key === generatedSqlRewriteKey
        ? current
        : {
          key: generatedSqlRewriteKey,
          sql: generatedSql,
          mode: null,
          reason: null,
          pending: true,
        },
    );
    void dbRewriteResultSql(generatedSqlRewriteRequest)
      .then((rewritten) => {
        if (cancelled) return;
        setResolvedGeneratedSql({
          key: generatedSqlRewriteKey,
          sql: rewritten.sql,
          mode: rewritten.mode,
          reason: rewritten.reason,
          pending: false,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const reason = `SQL rewrite preview failed: ${String(err)}`;
        setResolvedGeneratedSql({
          key: generatedSqlRewriteKey,
          sql: null,
          mode: "unsupported",
          reason,
          pending: false,
        });
        setLocalNotice(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [generatedSql, generatedSqlRewriteKey, generatedSqlRewriteRequest]);

  const currentRewrite = resolvedGeneratedSql?.key === generatedSqlRewriteKey ? resolvedGeneratedSql : null;
  const rewriteUnsupported = currentRewrite?.mode === "unsupported";
  const rewritePending = currentRewrite?.pending ?? false;
  const displayGeneratedSql =
    generatedSql && currentRewrite && !rewriteUnsupported ? currentRewrite.sql ?? generatedSql : generatedSql;
  const generatedSqlUnavailableReason =
    rewriteUnsupported ? currentRewrite?.reason ?? "SQL rewrite is not available for this result." : null;
  const displayGeneratedSqlTitle =
    generatedSqlUnavailableReason ?? displayGeneratedSql;
  const generatedSqlActionsDisabled =
    rewritePending || rewriteUnsupported || !displayGeneratedSql || !generatedSqlRewriteRequest;
  const generatedSqlBarText =
    generatedSqlUnavailableReason ?? (displayGeneratedSql ? compactSqlForDisplay(displayGeneratedSql) : "Rewriting SQL...");

  const resolveGeneratedSql = async (
    sql: string | null = generatedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ): Promise<string | null> => {
    if (!sql) return null;
    const key = resultSqlRewriteKey(request);
    if (key && resolvedGeneratedSql?.key === key && !resolvedGeneratedSql.pending) {
      if (resolvedGeneratedSql.mode === "inline" && resolvedGeneratedSql.sql) return resolvedGeneratedSql.sql;
      setStatus(resolvedGeneratedSql.reason ?? "SQL rewrite is not available for this result.");
      return null;
    }
    if (!request) return sql;
    try {
      const rewritten = await dbRewriteResultSql(request);
      setResolvedGeneratedSql({
        key,
        sql: rewritten.sql,
        mode: rewritten.mode,
        reason: rewritten.reason,
        pending: false,
      });
      if (rewritten.mode === "inline" && rewritten.sql) return rewritten.sql;
      setStatus(rewritten.reason ?? "SQL rewrite is not available for this result.");
      return null;
    } catch (err) {
      setResolvedGeneratedSql({
        key,
        sql: null,
        mode: null,
        reason: null,
        pending: false,
      });
      setStatus(`SQL rewrite failed: ${String(err)}`);
      return null;
    }
  };

  const copyGeneratedSql = async () => {
    const sql = await resolveGeneratedSql();
    if (!sql) return;
    try {
      await writeText(sql);
      setStatus("Copied generated SQL.");
    } catch (err) {
      setStatus(`Copy generated SQL failed: ${String(err)}`);
    }
  };

  const queryGeneratedSql = (
    sql = displayGeneratedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ) => {
    if (!sql) {
      setStatus("No local filter or sort changes to query.");
      return;
    }
    if (onGeneratedSqlQuery) {
      void Promise.resolve(onGeneratedSqlQuery(sql, request ?? undefined)).catch((err) => {
        setStatus(`Query generated SQL failed: ${String(err)}`);
      });
      return;
    }
    void syncGeneratedSql("sync", sql, request);
  };

  const syncGeneratedSql = async (
    mode: QueryGeneratedSqlSyncMode,
    sql = displayGeneratedSql,
    request: DbResultSqlRewriteRequest | null = generatedSqlRewriteRequest,
  ) => {
    const resolvedSql = await resolveGeneratedSql(sql, request);
    if (!resolvedSql) return;
    if (onGeneratedSqlSync) {
      onGeneratedSqlSync(resolvedSql, mode);
      return;
    }
    const targetTab = getActiveQueryTab() ?? listQueryTabs().find((entry) => entry.engine === sqlEngine);
    if (!targetTab) {
      setStatus("No SQL Commander editor is available.");
      return;
    }
    targetTab.insertQuery(resolvedSql, { destination: "current", position: "last" });
    setStatus("Inserted generated SQL in SQL Commander.");
  };
  return { generatedSql, displayGeneratedSqlTitle, generatedSqlBarText, generatedSqlActionsDisabled, queryGeneratedSql, copyGeneratedSql, syncGeneratedSql, resolvedGeneratedSql, setResolvedGeneratedSql };
}
