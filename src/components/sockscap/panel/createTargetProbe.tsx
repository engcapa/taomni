import { sockscapTestTarget, type TargetTestResult } from "../../../lib/sockscap";


export interface CreateTargetProbeContext {
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  testHost: string;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<TargetTestResult | null>>;
  t: import("../../../lib/i18n").TranslateFn;
  report: (text: string, ok?: boolean) => void;
  openTestDetail: (title: string, body: string) => void;
}

export function createTargetProbe(context: CreateTargetProbeContext) {
  const { setTesting, testHost, setTestResult, t, report, openTestDetail } = context;

  const onTestTarget = async () => {
    setTesting(true);
    try {
      const res = await sockscapTestTarget(testHost.trim(), 443);
      setTestResult(res);
      const summary = t("sockscap.testTargetResult", {
        host: res.host,
        decision: res.decision,
        reason: res.reason,
      });
      report(summary);
      const body = [
        `${t("sockscap.host")}: ${res.host}:${res.port}`,
        `${t("sockscap.testDecision")}: ${res.decision}`,
        `${t("sockscap.testMatchedRule")}: ${res.matchedRule || "-"}`,
        `${t("common.message")}: ${res.reason}`,
      ].join("\n");
      openTestDetail(t("sockscap.testTargetDetailTitle", { host: res.host }), body);
    } catch (e) {
      const err = String(e);
      report(err, false);
      openTestDetail(t("sockscap.testTargetDetailTitle", { host: testHost.trim() }), err);
    } finally {
      setTesting(false);
    }
  };
  return { onTestTarget };
}
