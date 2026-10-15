import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecoveryBootstrap } from "../../lib/runtimeRecovery";
import { RecoveryTerminalOutput } from "./RecoveryTerminalOutput";
import { recoveryLimitation } from "../../lib/recoveryPolicy";
import { RecoveryBackgroundStatus } from "./RecoveryBackgroundStatus";

/** Recovery is deliberately not a normal Tab mount: no connect / cleanup / autosave side effects. */
export function RecoveryWorkspace({ bootstrap }: { bootstrap: RecoveryBootstrap }) {
  const tabs = bootstrap.description?.tabs ?? [];
  const [selected, setSelected] = useState(bootstrap.description?.activeTabId ?? tabs[0]?.id ?? "");
  const [handshake, setHandshake] = useState("正在确认恢复界面…");
  const tab = tabs.find((entry) => entry.id === selected);
  useEffect(() => {
    let current = true;
    // StrictMode repeats effects; share this handshake rather than issuing a second ready.
    void readyOnce(bootstrap).then(
      () => { if (current) setHandshake("有限恢复界面已就绪"); },
      () => { if (current) setHandshake("恢复确认失败。后台未被关闭，请使用原生提示核对状态。"); },
    );
    return () => { current = false; };
  }, [bootstrap]);
  return (
    <main data-testid="recovery-workspace" style={{ padding: 24, color: "#ddd", background: "#202124", minHeight: "100vh" }}>
      <h1>界面已重新打开，后台任务未被关闭</h1>
      <p data-testid="recovery-handshake" role="status">{handshake}</p>
      <p data-testid="recovery-limitations">
        终端画面和输入模式尚未验证，当前不开放输入，不重建 shell、不重发启动命令。
        SQL、邮件、传输、AI、宏及采集不会自动重做。未保存编辑和操作结果可能不完整。
        标签描述可能较旧或因预算不完整；未记录的在飞创建仍可能在后台运行。主窗口失去控制的语音和原生音视频采集会停止；独立录屏/滚动截图可用原控制窗口核对，其控制界面退出时会请求安全停止。
      </p>
      {tabs.length === 0 && <p data-testid="recovery-missing">没有可用的标签描述。后台仍可能运行，未自动新建任何会话。</p>}
      <nav aria-label="恢复的标签" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {tabs.map((entry) => <button key={entry.id} data-testid="recovery-tab" data-kind={entry.kind}
          aria-pressed={entry.id === selected} onClick={() => setSelected(entry.id)}>{entry.title}</button>)}
      </nav>
      {tab && <section data-testid="recovery-detail" aria-live="polite">
        <h2>{tab.title}</h2>
        <p data-testid="recovery-kind">类型：{tab.kind}</p>
        <p data-testid="recovery-policy">{recoveryLimitation(tab.kind)}</p>
        {tab.terminalSessionId
          ? <p data-testid="recovery-terminal-id">原终端 ID：{tab.terminalSessionId}。画面未完整恢复，运行状态尚需核对；未创建替代终端。</p>
          : <p data-testid="recovery-unknown">未恢复此页面的连接或中间状态。请先核对后台结果，再决定是否重新打开；不要直接重复操作。</p>}
        {tab.terminalSessionId && <RecoveryTerminalOutput key={tab.terminalSessionId} sessionId={tab.terminalSessionId} />}
        {tab.kind === "mail" || tab.kind === "mail-unified"
          ? <p data-testid="recovery-mail-warning">发件箱自动发送已暂停；请核对发送结果与已保存草稿，避免重复发送。</p> : null}
      </section>}
      <RecoveryBackgroundStatus />
      <p>系统标题栏的关闭按钮可打开原生恢复 / 退出选项。选择保留后台不会终止原任务。</p>
    </main>
  );
}

// Per-renderer only; never persisted across native process restarts.
const handshakes = new WeakMap<RecoveryBootstrap, Promise<unknown>>();
function readyOnce(bootstrap: RecoveryBootstrap): Promise<unknown> {
  let promise = handshakes.get(bootstrap);
  if (!promise) {
    promise = invoke("recovery_ready", { instanceId: bootstrap.instanceId, generation: bootstrap.generation });
    handshakes.set(bootstrap, promise);
  }
  return promise;
}
