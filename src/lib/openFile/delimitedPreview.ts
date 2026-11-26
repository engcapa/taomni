/** Parse only the visible CSV prefix, including escaped quotes and embedded newlines. */
export function parseDelimitedPrefix(text: string, maxRows: number, delimiter = ",", complete = true): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (quoted || !fieldStarted) {
        quoted = !quoted;
      } else {
        field += character;
      }
      fieldStarted = true;
    } else if (!quoted && character === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      if (rows.length === maxRows) return { rows, truncated: !complete || index + 1 < text.length };
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += character;
      fieldStarted = true;
    }
  }
  if (complete && (fieldStarted || field.length > 0 || row.length > 0) && rows.length < maxRows) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated: !complete };
}
