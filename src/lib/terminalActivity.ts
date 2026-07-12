const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "sudo", "doas", "env", "time"]);
const OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-D", "--chdir"]),
  doas: new Set(["-u"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
};

/** Tokenize enough shell syntax to identify an executable without retaining args. */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (const char of command.trim()) {
    if (escaped) {
      token += /[\s'"\\]/.test(char) ? char : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "|" || char === ";" || char === "&") {
      push();
      // A leading PowerShell call operator is not the executable itself.
      if (tokens.length > 0) break;
      continue;
    }
    token += char;
  }
  push();
  return tokens;
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function basename(program: string): string {
  const name = program.split(/[\\/]/).filter(Boolean).at(-1) ?? program;
  return name.replace(/\.exe$/i, "");
}

/**
 * Best-effort, privacy-preserving executable label for terminal activity UI.
 * Only the executable basename is returned; arguments are intentionally
 * discarded because they frequently contain credentials or tokens.
 */
export function inferTerminalProgram(command: string): string | null {
  const tokens = commandTokens(command);
  let index = 0;

  while (index < tokens.length && isAssignment(tokens[index])) index += 1;

  while (index < tokens.length) {
    const wrapper = basename(tokens[index]).toLowerCase();
    if (!WRAPPERS.has(wrapper)) break;
    index += 1;
    const valueOptions = OPTIONS_WITH_VALUES[wrapper] ?? new Set<string>();
    while (index < tokens.length && tokens[index].startsWith("-")) {
      const option = tokens[index];
      index += 1;
      if (valueOptions.has(option) && index < tokens.length) index += 1;
    }
    while (index < tokens.length && isAssignment(tokens[index])) index += 1;
  }

  const program = tokens[index];
  if (!program || program === "-" || isAssignment(program)) return null;
  const label = basename(program).trim();
  return label || null;
}
