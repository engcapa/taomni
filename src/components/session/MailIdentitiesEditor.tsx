import { Plus, Trash2 } from "lucide-react";
import type { MailIdentity } from "../../types";

/**
 * Editor for additional sending identities (aliases) of a mail session.
 * Stored as a JSON array in the `mailIdentities` session option.
 */
export function MailIdentitiesEditor({
  identities,
  onChange,
}: {
  identities: MailIdentity[];
  onChange: (next: MailIdentity[]) => void;
}) {
  const update = (index: number, patch: Partial<MailIdentity>) =>
    onChange(identities.map((identity, i) => (i === index ? { ...identity, ...patch } : identity)));

  return (
    <div className="flex flex-col gap-2 w-[420px]" data-testid="mail-identities-editor">
      {identities.map((identity, index) => (
        <div
          key={identity.id}
          className="rounded border border-[var(--taomni-divider)] p-2 flex flex-col gap-1.5"
          data-testid="mail-identity-row"
        >
          <div className="flex gap-1.5">
            <input
              className="taomni-input flex-1"
              value={identity.name ?? ""}
              placeholder="Display name"
              aria-label={`Identity ${index + 1} display name`}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            <input
              className="taomni-input flex-1"
              value={identity.email}
              placeholder="alias@example.com"
              aria-label={`Identity ${index + 1} email`}
              data-testid="mail-identity-email"
              onChange={(e) => update(index, { email: e.target.value })}
            />
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              title="Remove identity"
              aria-label={`Remove identity ${index + 1}`}
              onClick={() => onChange(identities.filter((_, i) => i !== index))}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            className="taomni-input"
            value={identity.replyTo ?? ""}
            placeholder="Reply-To (optional)"
            aria-label={`Identity ${index + 1} reply-to`}
            onChange={(e) => update(index, { replyTo: e.target.value })}
          />
          <textarea
            className="taomni-input min-h-[52px] resize-y font-sans leading-5"
            value={identity.signature ?? ""}
            placeholder="Signature for this identity"
            aria-label={`Identity ${index + 1} signature`}
            onChange={(e) => update(index, { signature: e.target.value })}
          />
        </div>
      ))}
      <button
        type="button"
        className="taomni-btn h-7 px-2 self-start inline-flex items-center gap-1.5 text-[12px]"
        data-testid="mail-identity-add"
        onClick={() => onChange([
          ...identities,
          { id: `identity-${Date.now().toString(36)}`, name: "", email: "", replyTo: "", signature: "" },
        ])}
      >
        <Plus className="w-3.5 h-3.5" />
        Add identity
      </button>
    </div>
  );
}
