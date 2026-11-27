import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { IconButton } from "../../ui/IconButton";
import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, GraduationCap, Languages, Sparkles, WandSparkles, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey } from "../../../lib/ai/answerLanguage";
import type { AiAnswerLanguage, EditorAiAction } from "./editorAiPrompts";

export type { EditorAiAction } from "./editorAiPrompts";

interface EditorSelectionAiToolbarProps {
  visible: boolean;
  rect: { top: number; left: number; right: number; bottom: number } | null;
  selectionText: string;
  busy?: boolean;
  /** Language the AI should answer in; `inherit` follows the global default. */
  answerLanguage?: AiAnswerLanguage;
  onAction: (action: EditorAiAction, text: string) => void;
  /**
   * Pick the answer language. Omitted when the host does not persist it, which
   * also hides the picker.
   */
  onSetAnswerLanguage?: (language: AiAnswerLanguage) => void;
  onDismiss: () => void;
}

const BUTTON_CLASS =
  "h-7 inline-flex items-center gap-1 rounded px-2 text-ui-small text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40";

export function EditorSelectionAiToolbar({
  visible,
  rect,
  selectionText,
  busy = false,
  answerLanguage = "inherit",
  onAction,
  onSetAnswerLanguage,
  onDismiss,
}: EditorSelectionAiToolbarProps) {
  const t = useT();
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const languageRef = useRef<HTMLButtonElement>(null);

  // Close the picker on an outside click so it does not outlive the selection
  // it belongs to.
  // A fresh selection should not inherit the previous one's open menu.
  useEffect(() => {
    if (!visible) setLanguageMenuOpen(false);
  }, [visible]);

  if (!visible || !rect || selectionText.trim().length < 2) return null;

  const TOOLBAR_HEIGHT = 34;
  const PADDING = 8;
  // ED-PARITY-011 DEC-011-07: below the selection first, so the toolbar never
  // covers the line above (IDEA has no floating toolbar over code); above only
  // when the viewport bottom leaves no room.
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const placeBelow = rect.bottom + PADDING + TOOLBAR_HEIGHT + PADDING <= viewportHeight;
  const top = placeBelow ? rect.bottom + PADDING : Math.max(PADDING, rect.top - TOOLBAR_HEIGHT - PADDING);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 480));

  const languageBadge = t(answerLanguageLabelKey(answerLanguage));

  return (
    <div
      data-testid="code-workspace-ai-selection-toolbar"
      className="fixed z-[var(--taomni-z-popover)] flex items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] px-1 py-0.5 shadow-xl"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.explainTooltip")}
        onClick={() => onAction("explain", selectionText)}
      >
        <BookOpen className="h-3.5 w-3.5" />
        Explain
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.syntaxTooltip")}
        onClick={() => onAction("syntax", selectionText)}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        Syntax
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.fixTooltip")}
        onClick={() => onAction("fix", selectionText)}
      >
        <WandSparkles className="h-3.5 w-3.5" />
        Fix
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={busy}
        title={t("codeWorkspaceAi.rewriteTooltip")}
        onClick={() => onAction("rewrite", selectionText)}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask AI
      </button>
      {onSetAnswerLanguage && (
        <div className="relative">
          <button
            type="button"
            ref={languageRef}
            data-testid="code-workspace-ai-answer-language"
            aria-haspopup="menu"
            aria-expanded={languageMenuOpen}
            className="h-7 inline-flex items-center gap-1 rounded border-l border-[var(--taomni-code-border)] pl-2 pr-1.5 text-ui-caption text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
            title={t("codeWorkspaceAi.answerLanguageTooltip", { current: languageBadge })}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setLanguageMenuOpen((open) => !open);
            }}
          >
            <Languages className="h-3.5 w-3.5" />
            {languageBadge}
            <ChevronDown className="h-3 w-3" />
          </button>
          {languageMenuOpen && (
            <AnchoredMenu anchor={languageRef} testId="code-workspace-ai-answer-language-menu"
              ariaLabel={t("codeWorkspaceAi.answerLanguageTooltip", { current: languageBadge })}
              onClose={() => setLanguageMenuOpen(false)} items={AI_ANSWER_LANGUAGES.map((language) => ({
                label: t(answerLanguageLabelKey(language)),
                testId: `code-workspace-ai-answer-language-${language}`,
                role: "menuitemradio",
                checked: language === answerLanguage,
                onClick: () => onSetAnswerLanguage(language),
              }))} />
          )}
        </div>
      )}
      <IconButton
        type="button"
        className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
        labelKey="dismissAiToolbar"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}
