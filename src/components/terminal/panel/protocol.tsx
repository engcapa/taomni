
/** Upper bound on how long keystrokes wait for a hidden setup line to land. */
export const INJECTED_INPUT_HOLD_MAX_MS = 1_500;

export const CWD_SETUP_INPUT_HOLD_MAX_MS = 4_000;

export const CWD_QUERY_COMMAND =
  " printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; : __taomni_cwd_sync_done";

export function buildSshInitialCwdProbe(cwd: string): string {
  return " cd '" + cwd.replace(/'/g, "'\\''") + "' 2>/dev/null;" + CWD_QUERY_COMMAND;
}


// PowerShell equivalent of the OSC 7 cwd probe. `printf` doesn't exist in
// PowerShell, so we emit the escape sequence via [Console]::Write. The echo is
// hidden by the OSC-7 blanking suppressor (which keys off the real escape byte
// this prints at runtime), so no marker bookkeeping is needed here.
export const PS_CWD_QUERY_COMMAND =
  "[Console]::Write([char]27+']7;file://'+$env:COMPUTERNAME+'/'+($PWD.ProviderPath.Replace('\\','/'))+[char]27+'\\')";

export const OSC52_MAX_DECODED_BYTES = 1024 * 1024;


export function parseOsc7(data: string): string | null {
  // OSC 7 payload looks like `file://hostname/path/with%20spaces`.
  const match = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}


/** Build a history line the Welcome recent-folders parser can turn into a path. */
export function formatHistoryCdCommand(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "cd";
  if (/[\s"'`]/.test(trimmed) || /[&|;<>]/.test(trimmed)) {
    return `cd "${trimmed.replace(/"/g, '\\"')}"`;
  }
  return `cd ${trimmed}`;
}


export function parseOsc52ClipboardText(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;

  const targets = data.slice(0, separator);
  if (targets && !targets.includes("c") && !targets.includes("s")) return null;

  const encoded = data.slice(separator + 1).replace(/\s/g, "");
  if (!encoded || encoded === "?") return encoded === "" ? "" : null;
  if (encoded.length > Math.ceil((OSC52_MAX_DECODED_BYTES * 4) / 3) + 4) return null;

  try {
    const binary = atob(encoded);
    if (binary.length > OSC52_MAX_DECODED_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}


export function encodeBinaryStringBase64(str: string): string {
  let binary = "";
  for (let i = 0; i < str.length; i++) {
    binary += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}


export function formatZmodemBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
