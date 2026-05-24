import type { SessionConfig } from "./ipc";
import { folderOptionLabel, splitGroupPath } from "./sessionPaths";
import type { SessionExportResult } from "./sessionImportExport";

export function serializeHtmlSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const label = folderOptionLabel(scopeFolder);
  const rows = sessions.map((session) => `
      <tr>
        <td>${escapeHtml(session.name)}</td>
        <td>${escapeHtml(session.session_type)}</td>
        <td>${escapeHtml(session.host)}</td>
        <td>${session.port}</td>
        <td>${escapeHtml(session.username ?? "")}</td>
      </tr>`).join("");
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(label)}</title>
  <style>
    body { font: 13px system-ui, sans-serif; margin: 24px; color: #1d2330; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #c8cdd4; padding: 6px 8px; text-align: left; }
    th { background: #eaf1fa; }
  </style>
</head>
<body>
  <h1>${escapeHtml(label)}</h1>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Host</th><th>Port</th><th>User</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

  return {
    filename: `${slugify(label)}.html`,
    text: html,
    mimeType: "text/html",
    warnings: [],
    skipped: 0,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value: string): string {
  return splitGroupPath(value).join("-").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "user-sessions";
}
