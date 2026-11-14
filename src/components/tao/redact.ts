const REDACTION_RULES: Array<[string, RegExp]> = [
  ["password", /\b(password|passwd|pwd)\s*[=:]\s*[^\s]+/gi],
  ["token", /\b(token|api[_-]?key|secret|auth)\s*[=:]\s*[^\s]+/gi],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/g],
  ["authorization", /\bAuthorization\s*:\s*[^\s]+/gi],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g],
  ["connection", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)\:\/\/[^\s]+/gi],
  ["x-api-key", /\bX-Api-Key\s*:\s*[^\s]+/gi],
];

export interface RedactionResult { text: string; count: number; rules: Record<string, number>; }

export function redactText(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const rules: Record<string, number> = {};
  for (const [name, pattern] of REDACTION_RULES) {
    let hits = 0;
    text = text.replace(pattern, () => {
      hits += 1;
      return "[已脱敏]";
    });
    if (hits > 0) {
      rules[name] = hits;
      count += hits;
    }
  }
  return { text, count, rules };
}

export function redactionRuleNames(): string[] {
  return REDACTION_RULES.map(([name]) => name);
}
