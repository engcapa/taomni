import { useId, useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import { useT } from "../../lib/i18n";
import { openExternalUrl } from "../../lib/sftp";

const steps = ["create", "permissions", "publish", "user", "chat", "connect", "events", "verify"] as const;
const links: Partial<Record<typeof steps[number], { url: string; testId: string }>> = {
  create: { url: "https://open.feishu.cn/app", testId: "feishu-guide-console" },
  user: { url: "https://open.feishu.cn/api-explorer?apiName=create&project=im&resource=message&version=v1", testId: "feishu-guide-explorer" },
  chat: { url: "https://open.feishu.cn/document/server-docs/im-v1/message/create", testId: "feishu-guide-message-docs" },
  events: { url: "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case", testId: "feishu-guide-connection-docs" },
};
const messageExample = JSON.stringify({
  receive_id: "ou_REPLACE_WITH_USER_OPEN_ID",
  msg_type: "text",
  content: JSON.stringify({ text: "Taomni setup test" }),
}, null, 2);

export function FeishuSetupGuide() {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [linkError, setLinkError] = useState("");
  const key = "feishuSettings.guide";
  return (
    <div>
      <button
        type="button"
        data-testid="feishu-guide-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] px-3 py-1.5 hover:bg-[var(--taomni-hover)]"
        onClick={() => setOpen(value => !value)}
      >
        <CircleHelp aria-hidden="true" className="h-4 w-4" />
        {t(`${key}.${open ? "hide" : "show"}`)}
        {open ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div id={panelId} data-testid="feishu-guide" className="mt-3 max-h-[65vh] overflow-y-auto rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-4 leading-relaxed break-words">
          <h5 className="font-semibold">{t(`${key}.title`)}</h5>
          <p className="mt-2 text-[var(--taomni-text-muted)]">{t(`${key}.intro`)}</p>
          <ol className="mt-4 list-decimal space-y-5 pl-5">
            {steps.map(step => {
              const link = links[step];
              return (
                <li key={step} data-testid={`feishu-guide-step-${step}`} className="pl-1 space-y-2">
                  <h6 className="font-semibold">{t(`${key}.${step}.title`)}</h6>
                  <p>{t(`${key}.${step}.body`)}</p>
                  {step === "permissions" && <ul className="list-disc space-y-1 pl-5">
                    <li><code>im:message:send_as_bot</code> — {t(`${key}.permissions.send`)}</li>
                    <li><code>im:message.p2p_msg:readonly</code> — {t(`${key}.permissions.receive`)}</li>
                  </ul>}
                  {step === "chat" && <>
                    <pre data-testid="feishu-guide-message-example" className="overflow-x-auto rounded bg-[var(--taomni-bg)] p-3 text-xs whitespace-pre-wrap break-all"><code>{messageExample}</code></pre>
                    <p>{t(`${key}.chat.binding`)}</p>
                    <code data-testid="feishu-guide-binding-example" className="block select-all break-all">ou_YOUR_USER_OPEN_ID oc_YOUR_CHAT_ID</code>
                  </>}
                  {step === "connect" && <p>{t(`${key}.connect.start`)}</p>}
                  {(["permissions", "chat", "events"] as readonly string[]).includes(step) && <p className="text-[var(--taomni-text-muted)]">{t(`${key}.${step}.note`)}</p>}
                  {step === "verify" && <p>{t(`${key}.verify.troubleshooting`)}</p>}
                  {link && <a
                    href={link.url}
                    data-testid={link.testId}
                    className="inline-block text-[var(--taomni-accent)] underline"
                    onClick={event => {
                      event.preventDefault();
                      setLinkError("");
                      void openExternalUrl(link.url).catch(error => setLinkError(String(error)));
                    }}
                  >{t(`${key}.${step}.link`)}</a>}
                </li>
              );
            })}
          </ol>
          {linkError && <p role="alert" className="mt-3">{t("mobileSettings.operationFailed", { detail: linkError })}</p>}
        </div>
      )}
    </div>
  );
}
