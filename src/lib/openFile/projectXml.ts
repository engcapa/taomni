import { viewerReadText } from "../viewer";

const PROJECT_NS = "http://schemas.microsoft.com/project";
const PROJECT_PREFIX_BYTES = 4096;

export function hasProjectRoot(prefix: string): boolean {
  let xml = prefix.trimStart();
  while (xml.startsWith("<?") || xml.startsWith("<!--")) {
    const terminator = xml.startsWith("<?") ? "?>" : "-->";
    const end = xml.indexOf(terminator);
    if (end === -1) return false;
    xml = xml.slice(end + terminator.length).trimStart();
  }
  const root = /^<(?:[\w.-]+:)?Project(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/u.exec(xml)?.[0];
  if (!root) return false;
  const parsed = new DOMParser().parseFromString(root.replace(/\/?>$/u, "/>"), "application/xml");
  return parsed.documentElement.localName === "Project" && parsed.documentElement.namespaceURI === PROJECT_NS;
}

export async function isProjectXml(path: string): Promise<boolean> {
  try {
    const preview = await viewerReadText(path, PROJECT_PREFIX_BYTES);
    return hasProjectRoot(preview.content);
  } catch {
    return false;
  }
}
