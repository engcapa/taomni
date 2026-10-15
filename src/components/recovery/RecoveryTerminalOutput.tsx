import { useEffect, useState } from "react";
import { appendRecoveryOutput, observeRecoveryTerminal } from "../../lib/recoveryTerminal";

export function RecoveryTerminalOutput({ sessionId }: { sessionId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("未订阅输出");
  useEffect(() => {
    if (!enabled) { setStatus("未订阅输出"); return; }
    let active = true;
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus("正在接回原终端的输出…");
    const observation = observeRecoveryTerminal(sessionId, (chunk) => {
      pending = appendRecoveryOutput(pending, chunk);
      if (timer === null) timer = setTimeout(() => {
        timer = null;
        if (active) setOutput(pending);
      }, 32);
    });
    void observation.ready.then(
      () => { if (active) setStatus("已订阅原终端；无输出不代表任务已结束"); },
      () => { if (active) setStatus("原终端不存在、已结束或无法接回；未创建新终端"); },
    );
    return () => { active = false; if (timer !== null) clearTimeout(timer); observation.stop(); };
  }, [enabled, sessionId]);
  return <div>
    <p>仅观察接回后的原始输出，最多保留 64K 字符；此前画面、历史、光标和模式未恢复，不支持输入。</p>
    <button data-testid="recovery-observe" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}>
      {enabled ? "停止观察（保留后台）" : "观察原终端输出（只读）"}
    </button>
    <p data-testid="recovery-output-status" role="status">{status}</p>
    <pre data-testid="recovery-output" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto" }}>{output}</pre>
  </div>;
}
