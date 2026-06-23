/**
 * Build the one-shot command that installs continuous OSC 7 cwd reporting on a
 * remote SSH shell, injected once after the shell comes up.
 *
 * Why this exists: duplicating a tab needs the source's working directory.
 * Rather than probe the source terminal each time (which leaks the probe's echo
 * and corrupts any half-typed line), we make the remote shell emit OSC 7 on
 * every prompt. The frontend already tracks OSC 7, so the cwd is always known
 * and duplication just reads it.
 *
 * The command:
 *   1. (optional) `cd` to the source tab's dir — SSH can't set a channel start
 *      directory, so a duplicate "follows" the source by cd-ing here first.
 *   2. defines an OSC 7 emitter (`__taomni_osc7`),
 *   3. registers it to run before each prompt — bash via PROMPT_COMMAND
 *      (idempotent, preserving any existing one), zsh via precmd_functions,
 *   4. runs it once, which emits the real OSC 7 the blanking suppressor keys on
 *      to know the injected line is done and stop hiding output.
 *
 * Best-effort POSIX (bash/zsh). A non-POSIX remote errors on the line; the
 * caller hides that with a short-TTL suppressor and falls back to no cwd
 * tracking. Bash history is disabled for this one injected line and the guard
 * removes itself from history before installing the prompt hook. The leading
 * space remains a cheap extra guard for shells with ignorespace enabled.
 *
 * Note: this is assembled from plain strings (not template literals) so the
 * `${...}` shell parameter expansions are emitted verbatim, not interpolated.
 */
const SSH_CWD_HISTORY_GUARD =
  " __taomni_hist_restore=;" +
  " if [ -n \"$BASH_VERSION\" ] && (set -o | grep -q '^history[[:space:]]*on'); then __taomni_hist_restore=1; set +o history; history -d $((HISTCMD-1)) 2>/dev/null; fi;";

const SSH_CWD_HISTORY_RESTORE =
  " if [ -n \"${__taomni_hist_restore:-}\" ]; then set -o history; fi; unset __taomni_hist_restore";

const SSH_CWD_INTEGRATION_INSTALL =
  " __taomni_osc7(){ printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"$PWD\"; };" +
  " if [ -n \"$ZSH_VERSION\" ]; then typeset -ag precmd_functions 2>/dev/null; precmd_functions+=(__taomni_osc7);" +
  " elif [ -n \"$BASH_VERSION\" ]; then case \";$PROMPT_COMMAND;\" in *\";__taomni_osc7;\"*) ;;" +
  " *) PROMPT_COMMAND=\"__taomni_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac; fi;" +
  " __taomni_osc7;";

export const SSH_CWD_INTEGRATION_BODY =
  SSH_CWD_HISTORY_GUARD + SSH_CWD_INTEGRATION_INSTALL + SSH_CWD_HISTORY_RESTORE;

export function buildSshCwdIntegration(cwd?: string): string {
  const cd = cwd ? " cd '" + cwd.replace(/'/g, "'\\''") + "' 2>/dev/null;" : "";
  return SSH_CWD_HISTORY_GUARD + cd + SSH_CWD_INTEGRATION_INSTALL + SSH_CWD_HISTORY_RESTORE;
}
