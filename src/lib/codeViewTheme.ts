import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--taomni-code-syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [
      tags.keyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.modifier,
      tags.controlKeyword,
      tags.operatorKeyword,
    ],
    color: "var(--taomni-code-syntax-keyword)",
    fontWeight: "500",
  },
  {
    tag: [tags.self, tags.null, tags.atom, tags.bool, tags.unit],
    color: "var(--taomni-code-syntax-atom)",
  },
  {
    tag: [tags.number, tags.integer, tags.float],
    color: "var(--taomni-code-syntax-number)",
  },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: "var(--taomni-code-syntax-string)",
  },
  {
    tag: [tags.regexp, tags.escape, tags.special(tags.string)],
    color: "var(--taomni-code-syntax-escape)",
  },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
    ],
    color: "var(--taomni-code-syntax-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName, tags.namespace],
    color: "var(--taomni-code-syntax-type)",
  },
  {
    tag: [tags.propertyName, tags.attributeName],
    color: "var(--taomni-code-syntax-property)",
  },
  {
    tag: [tags.variableName, tags.name, tags.labelName, tags.macroName],
    color: "var(--taomni-code-syntax-variable)",
  },
  {
    tag: [
      tags.operator,
      tags.derefOperator,
      tags.arithmeticOperator,
      tags.logicOperator,
      tags.bitwiseOperator,
      tags.compareOperator,
      tags.updateOperator,
      tags.definitionOperator,
      tags.typeOperator,
      tags.controlOperator,
    ],
    color: "var(--taomni-code-syntax-operator)",
  },
  {
    tag: [
      tags.punctuation,
      tags.separator,
      tags.bracket,
      tags.angleBracket,
      tags.squareBracket,
      tags.paren,
      tags.brace,
    ],
    color: "var(--taomni-code-syntax-punctuation)",
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--taomni-code-syntax-link)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--taomni-code-syntax-link) 60%, transparent)",
  },
  {
    tag: tags.heading,
    color: "var(--taomni-code-syntax-heading)",
    fontWeight: "600",
  },
  {
    tag: tags.strong,
    fontWeight: "700",
  },
  {
    tag: tags.emphasis,
    fontStyle: "italic",
  },
  {
    tag: tags.inserted,
    color: "var(--taomni-code-syntax-inserted)",
  },
  {
    tag: tags.deleted,
    color: "var(--taomni-code-syntax-deleted)",
  },
  {
    tag: tags.changed,
    color: "var(--taomni-code-syntax-changed)",
  },
  {
    tag: tags.invalid,
    color: "var(--taomni-code-syntax-invalid)",
    textDecoration: "underline wavy var(--taomni-code-syntax-invalid)",
  },
]);

export const codeSyntaxHighlighting = syntaxHighlighting(codeHighlightStyle, { fallback: true });

export const codeViewTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "var(--taomni-code-font-size)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--taomni-code-font-family)",
    lineHeight: "var(--taomni-code-line-height)",
    fontFeatureSettings: "var(--taomni-code-font-features)",
    overflow: "auto",
  },
  ".cm-content": {
    color: "var(--taomni-code-text)",
    caretColor: "var(--taomni-code-caret)",
    padding: "8px 0",
  },
  ".cm-line": {
    color: "var(--taomni-code-text)",
    padding: "0 12px 0 6px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--taomni-code-gutter-bg)",
    color: "var(--taomni-code-line-number)",
    borderRight: "1px solid var(--taomni-code-border)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "4.25ch",
    padding: "0 10px 0 12px",
  },
  ".cm-gutterElement": {
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--taomni-code-active-line-bg)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--taomni-code-active-line-gutter-bg)",
    color: "var(--taomni-code-line-number-active)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--taomni-code-selection-bg) !important",
  },
  ".cm-content ::selection": {
    backgroundColor: "var(--taomni-code-selection-bg)",
    color: "var(--taomni-code-selection-text)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--taomni-code-selection-match-bg)",
    outline: "1px solid var(--taomni-code-selection-match-border)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--taomni-code-caret)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--taomni-code-bracket-match-bg)",
    outline: "1px solid var(--taomni-code-bracket-match-border)",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "var(--taomni-code-bracket-error-bg)",
    outline: "1px solid var(--taomni-code-syntax-invalid)",
  },
  ".cm-tooltip, .cm-tooltip-autocomplete": {
    backgroundColor: "var(--taomni-code-tooltip-bg)",
    color: "var(--taomni-code-text)",
    border: "1px solid var(--taomni-code-border)",
    boxShadow: "var(--taomni-shadow-md)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--taomni-code-active-line-bg)",
    color: "var(--taomni-code-text)",
  },
  ".cm-completionIcon": {
    color: "var(--taomni-code-muted)",
  },
  ".cm-completionMatchedText": {
    color: "var(--taomni-code-syntax-function)",
    textDecoration: "none",
    fontWeight: "600",
  },
});

export function codeViewExtensions(): Extension[] {
  return [codeSyntaxHighlighting, codeViewTheme];
}
