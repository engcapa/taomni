import { describe, expect, it } from "vitest";
import { buildSshCwdIntegration, SSH_CWD_INTEGRATION_BODY } from "./terminalShellIntegration";

describe("buildSshCwdIntegration", () => {
  it("emits a printf OSC 7 form matching the frontend parser", () => {
    // Real backslashes so the remote printf produces ESC ] 7 ; ... ESC \.
    expect(SSH_CWD_INTEGRATION_BODY).toContain("printf '\\033]7;file://%s%s\\033\\\\'");
    expect(SSH_CWD_INTEGRATION_BODY).toContain('"${HOSTNAME:-localhost}"');
    expect(SSH_CWD_INTEGRATION_BODY).toContain('"$PWD"');
  });

  it("registers the hook for bash and zsh and runs it once at the end", () => {
    expect(SSH_CWD_INTEGRATION_BODY).toContain("precmd_functions+=(__taomni_osc7)");
    // bash: prepend our hook, preserve any existing PROMPT_COMMAND.
    expect(SSH_CWD_INTEGRATION_BODY).toContain(
      'PROMPT_COMMAND="__taomni_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    );
    expect(SSH_CWD_INTEGRATION_BODY.trimEnd().endsWith("__taomni_osc7")).toBe(true);
  });

  it("is idempotent for bash so reconnects don't stack the hook", () => {
    // The case guard skips re-adding when already present.
    expect(SSH_CWD_INTEGRATION_BODY).toContain('case ";$PROMPT_COMMAND;" in *";__taomni_osc7;"*)');
  });

  it("has a leading space to dodge shell history (HISTCONTROL=ignorespace)", () => {
    expect(buildSshCwdIntegration()).toMatch(/^ /);
    expect(buildSshCwdIntegration("/var/log")).toMatch(/^ /);
  });

  it("omits the cd when no cwd is given", () => {
    expect(buildSshCwdIntegration()).toBe(SSH_CWD_INTEGRATION_BODY);
    expect(buildSshCwdIntegration()).not.toContain(" cd ");
  });

  it("cd's into the source directory first so a duplicate follows it", () => {
    const out = buildSshCwdIntegration("/var/log");
    expect(out.startsWith(" cd '/var/log' 2>/dev/null;")).toBe(true);
    expect(out.endsWith(SSH_CWD_INTEGRATION_BODY)).toBe(true);
  });

  it("single-quote-escapes the directory to resist injection", () => {
    const out = buildSshCwdIntegration("/tmp/O'Brien");
    expect(out).toContain(" cd '/tmp/O'\\''Brien' 2>/dev/null;");
  });
});
