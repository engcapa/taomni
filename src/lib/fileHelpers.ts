import { getAppPlatform } from "./runtime";

/**
 * File open/save helpers for session import/export and similar flows.
 *
 * These use the webview's built-in HTML `<input type="file">` chooser and a Blob
 * download. The webview owns and parents those dialogs to the app window, so
 * they stay attached and never sink behind it on focus loss (unlike a spawned
 * `zenity`/`kdialog` process, whose file-selection window cannot be reliably
 * parented).
 *
 * On Linux the WebKitGTK chooser builds its filter from MIME types only and
 * silently drops extensions that have no MIME mapping (e.g. ZeroOmega `.bak`,
 * WindTerm `.sessions`, Xshell `.xsh`/`.xts`) with no "All files" escape hatch.
 * So we skip the `accept` filter on Linux and show every file; the importers
 * validate by content rather than by suffix. macOS/Windows handle the `accept`
 * list correctly (and offer an "All files" option), so we keep it there.
 */

function applyAccept(input: HTMLInputElement, accept: string): void {
  if (getAppPlatform() !== "linux") {
    input.accept = accept;
  }
}

export function openTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    applyAccept(input, accept);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve).catch(reject);
    };
    input.click();
  });
}

export interface OpenedTextFile {
  name: string;
  text: string;
}

export function openTextFileWithName(accept: string): Promise<OpenedTextFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    applyAccept(input, accept);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then((text) => resolve({ name: file.name, text })).catch(reject);
    };
    input.click();
  });
}

export function openBinaryFile(accept: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    applyAccept(input, accept);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.arrayBuffer().then(resolve).catch(reject);
    };
    input.click();
  });
}

export function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
