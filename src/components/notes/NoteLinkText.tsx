import type { ReactNode } from "react";
import { extractNoteUrls } from "../../lib/notes/noteLinks";

export function renderLinkedNoteText(text: string): ReactNode[] {
  const matches = extractNoteUrls(text);
  if (matches.length === 0) return [text || "\u00a0"];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) nodes.push(text.slice(cursor, match.start));
    nodes.push(
      <span className="notes-rendered-link" key={`${match.start}-${match.end}-${index}`}>
        {text.slice(match.start, match.end)}
      </span>,
    );
    cursor = match.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
