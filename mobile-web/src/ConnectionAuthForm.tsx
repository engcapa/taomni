import { useEffect, useRef, useState } from "react";
import { errorText, request, type Instance } from "./api";
import type { ConnectionChallenge } from "./openSession";

/** Kept only while this round is visible. No storage, history or vault writes. */
export function ConnectionAuthForm({ instance, requestId, challenge, onCancel }: { instance: Instance; requestId: string; challenge: ConnectionChallenge; onCancel: () => void }) {
  const [values, setValues] = useState(() => challenge.prompts.map(p => p.echo ? p.initial || "" : ""));
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    return () => controller.abort();
  }, []);
  const submit = async () => {
    if (sending || sent) return;
    setSending(true); setError("");
    try {
      await request(instance, `/open-requests/${encodeURIComponent(requestId)}/auth`, { challenge_id: challenge.id, responses: values }, abort.current.signal);
      setValues(challenge.prompts.map(() => "")); setSent(true);
    } catch (error) { if (!abort.current.signal.aborted) setError(errorText(error)); }
    finally { if (!abort.current.signal.aborted) setSending(false); }
  };
  return <form className="card connection-auth" data-testid="mobile-connection-auth" onSubmit={event => { event.preventDefault(); void submit(); }} autoComplete="off">
    <h3>{challenge.name || "连接认证"}</h3>
    {challenge.instructions && <p className="note">{challenge.instructions}</p>}
    {challenge.prompts.map((prompt, index) => <label key={index}>{prompt.prompt || `认证信息 ${index + 1}`}
      <input data-testid={`mobile-auth-answer-${index}`} type={prompt.echo ? "text" : "password"} value={values[index]} disabled={sending || sent}
        autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={8192}
        onChange={event => setValues(current => current.map((value, i) => i === index ? event.target.value : value))} />
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div className="actions"><button type="button" data-testid="mobile-auth-cancel" onClick={onCancel}>取消连接</button><button className="primary" data-testid="mobile-auth-submit" disabled={sending || sent}>{sent ? "等待连接…" : sending ? "提交中…" : "继续连接"}</button></div>
    <small className="muted">认证信息仅本次使用，不保存到手机。</small>
  </form>;
}
