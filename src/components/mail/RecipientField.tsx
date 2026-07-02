import { useEffect, useMemo, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import {
  addRecipientsUnique,
  currentDomainSuggestion,
  formatRecipientForSend,
  isValidEmailAddress,
  mergeRecipientSuggestions,
  parseRecipientsText,
  recipientLabel,
  type ComposeRecipient,
  type RecipientSuggestion,
} from "../../lib/mailRecipients";

interface RecipientFieldProps {
  id: string;
  label: string;
  recipients: ComposeRecipient[];
  suggestions: RecipientSuggestion[];
  defaultDomain: string | null;
  loading?: boolean;
  disabled?: boolean;
  dataTestId: string;
  onChange: (recipients: ComposeRecipient[]) => void;
  onQueryChange?: (query: string) => void;
}

function suggestionLabel(suggestion: RecipientSuggestion): string {
  const name = suggestion.name?.trim();
  return name ? `${name} <${suggestion.email}>` : suggestion.email;
}

function suggestionSourceLabel(source: RecipientSuggestion["source"]): string {
  if (source === "domain") return "current domain";
  if (source === "sent") return "sent";
  if (source === "typed") return "recent";
  return "history";
}

export function RecipientField({
  id,
  label,
  recipients,
  suggestions,
  defaultDomain,
  loading = false,
  disabled = false,
  dataTestId,
  onChange,
  onQueryChange,
}: RecipientFieldProps) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = input.trim();

  const visibleSuggestions = useMemo(() => {
    if (!query) return [];
    const merged = mergeRecipientSuggestions(suggestions, [], recipients, 8);
    const fallback = merged.length === 0 && !loading ? currentDomainSuggestion(query, defaultDomain, recipients) : null;
    return fallback ? [...merged, fallback] : merged;
  }, [defaultDomain, loading, query, recipients, suggestions]);

  useEffect(() => {
    if (!focused) {
      onQueryChange?.("");
      return;
    }
    onQueryChange?.(query);
  }, [focused, onQueryChange, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, visibleSuggestions.length]);

  const commitRecipients = (nextRecipients: ComposeRecipient[]) => {
    onChange(addRecipientsUnique(recipients, nextRecipients));
    setInput("");
  };

  const commitInput = () => {
    const parsed = parseRecipientsText(input);
    if (parsed.length === 0) return false;
    commitRecipients(parsed);
    return true;
  };

  const acceptSuggestion = (suggestion: RecipientSuggestion) => {
    commitRecipients([{ name: suggestion.name ?? null, email: suggestion.email }]);
  };

  const removeRecipient = (index: number) => {
    onChange(recipients.filter((_, candidateIndex) => candidateIndex !== index));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % visibleSuggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + visibleSuggestions.length) % visibleSuggestions.length);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && visibleSuggestions.length > 0) {
      event.preventDefault();
      acceptSuggestion(visibleSuggestions[Math.min(activeIndex, visibleSuggestions.length - 1)]);
      return;
    }
    if (event.key === "Enter" && input.trim()) {
      event.preventDefault();
      commitInput();
      return;
    }
    if (event.key === "," || event.key === ";") {
      event.preventDefault();
      commitInput();
      return;
    }
    if (event.key === "Backspace" && input.length === 0 && recipients.length > 0) {
      event.preventDefault();
      removeRecipient(recipients.length - 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[;,\n]/.test(text)) return;
    const parsed = parseRecipientsText(text);
    if (parsed.length === 0) return;
    event.preventDefault();
    commitRecipients(parsed);
  };

  return (
    <>
      <label className="self-start pt-1.5 text-[var(--taomni-text-muted)]" htmlFor={id}>
        {label}
      </label>
      <div className="relative min-w-0" data-testid={dataTestId}>
        <div
          className="taomni-input min-h-8 px-1.5 py-1 flex flex-wrap items-center gap-1.5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              document.getElementById(id)?.focus();
            }
          }}
        >
          {recipients.map((recipient, index) => {
            const valid = isValidEmailAddress(recipient.email);
            return (
              <span
                key={`${recipient.email}-${index}`}
                className={`max-w-full h-6 px-1.5 rounded border inline-flex items-center gap-1 text-[12px] leading-none ${valid ? "border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]" : "border-red-500/70 bg-red-500/10 text-red-200"}`}
                title={formatRecipientForSend(recipient)}
                data-testid="mail-recipient-chip"
                data-invalid={!valid || undefined}
              >
                <span className="min-w-0 max-w-[220px] truncate">{recipientLabel(recipient)}</span>
                <button
                  type="button"
                  className="shrink-0 h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                  aria-label={`Remove ${recipient.email}`}
                  onClick={() => removeRecipient(index)}
                  disabled={disabled}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
          <input
            id={id}
            className="min-w-[120px] flex-1 h-6 bg-transparent outline-none text-[12px]"
            value={input}
            disabled={disabled}
            aria-label={label}
            autoComplete="off"
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commitInput();
            }}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
        {focused && query && (visibleSuggestions.length > 0 || loading) && (
          <div
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-[170] max-h-52 overflow-auto rounded border bg-[var(--taomni-bg)] shadow-xl"
            style={{ borderColor: "var(--taomni-divider)" }}
            data-testid="mail-recipient-suggestions"
          >
            {loading && visibleSuggestions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-[var(--taomni-text-muted)]">Searching</div>
            ) : (
              visibleSuggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.source}-${suggestion.email}`}
                  type="button"
                  className={`w-full min-w-0 px-2 py-1.5 flex items-center gap-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] ${index === activeIndex ? "bg-[var(--taomni-selected)]" : ""}`}
                  data-testid="mail-recipient-suggestion"
                  data-active={index === activeIndex || undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptSuggestion(suggestion);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{suggestionLabel(suggestion)}</span>
                  <span className="shrink-0 text-[11px] text-[var(--taomni-text-muted)]">{suggestionSourceLabel(suggestion.source)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}
