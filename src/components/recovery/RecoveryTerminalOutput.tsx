import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "../ui/Button";
import { appendRecoveryOutput, observeRecoveryTerminal } from "../../lib/recoveryTerminal";

export function RecoveryTerminalOutput({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("outputIdle");
  useEffect(() => {
    if (!enabled) { setStatus("outputIdle"); return; }
    let active = true;
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus("outputPending");
    const observation = observeRecoveryTerminal(sessionId, (chunk) => {
      pending = appendRecoveryOutput(pending, chunk);
      if (timer === null) timer = setTimeout(() => {
        timer = null;
        if (active) setOutput(pending);
      }, 32);
    });
    void observation.ready.then(
      () => { if (active) setStatus("outputActive"); },
      () => { if (active) setStatus("outputFailed"); },
    );
    return () => { active = false; if (timer !== null) clearTimeout(timer); observation.stop(); };
  }, [enabled, sessionId]);
  return <div>
    <p>{t("recovery.outputHint")}</p>
    <Button data-testid="recovery-observe" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}>
      {t(enabled ? "recovery.stopObserving" : "recovery.observe")}
    </Button>
    <p data-testid="recovery-output-status" role="status">{t(`recovery.${status}`)}</p>
    <pre data-testid="recovery-output" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto" }}>{output}</pre>
  </div>;
}
