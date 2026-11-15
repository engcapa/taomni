import { useEffect, type RefObject } from "react";
import { useAppStore } from "../../stores/appStore";
import { fileOpenWorkspaceForTab } from "../../lib/fileOpenContext";
import { findFilePathLinks, parseFilePathLink } from "../../lib/filePathLinks";
import { openFile } from "../../lib/openFile";
import { getLocale } from "../../lib/i18n";
import { getTerminal } from "../../lib/terminal/terminalRegistry";

/** File chips are a separate action from inline shell/query snippets. */
export function useChatFileLinks(rootRef: RefObject<HTMLElement | null>, enabled: boolean, content: string, preferredTerminalTabId?: string | null) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const app = useAppStore.getState();
    const tabId = preferredTerminalTabId ?? app.activeTabId ?? undefined;
    const terminal = getTerminal(tabId);
    const cwd = terminal?.localEnvironment && tabId ? app.cwdByTab[tabId] : undefined;
    const created: HTMLElement[] = [];
    const altered: Array<{ node: HTMLElement; attributes: Array<[string, string]> }> = [];
    const decorate = (node: HTMLElement, path: string, line?: number) => {
      if (!created.includes(node)) altered.push({ node, attributes: [...node.attributes].map((attr) => [attr.name, attr.value]) });
      node.setAttribute("data-testid", "ai-file-link");
      node.setAttribute("data-file-path", path);
      if (line) node.setAttribute("data-file-line", String(line));
      node.setAttribute("role", "link");
      node.tabIndex = 0;
      node.title = getLocale().startsWith("zh") ? "用 Taomni 打开" : "Open with Taomni";
      node.classList.add("cursor-pointer", "underline", "text-[var(--taomni-accent)]");
    };
    for (const node of root.querySelectorAll<HTMLElement>("a, code:not(pre code)")) {
      if (node.closest("pre")) continue;
      const raw = node.tagName === "A" ? node.getAttribute("href") ?? node.textContent ?? "" : node.textContent ?? "";
      // A remote conversation must not interpret a Linux-looking SSH path as
      // the same local file. Users can download through the SFTP entry first.
      if (terminal && !terminal.localEnvironment) continue;
      const link = parseFilePathLink(raw, cwd);
      if (link) decorate(node, link.path, link.line);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest("[data-chat-richtext]") && !node.parentElement.closest("a, code, pre, button, [data-file-path]")) textNodes.push(node);
    }
    if (!terminal || terminal.localEnvironment) for (const node of textNodes) {
      const text = node.textContent ?? "";
      const links = findFilePathLinks(text, cwd);
      if (!links.length) continue;
      const fragment = document.createDocumentFragment();
      let end = 0;
      for (const link of links) {
        fragment.append(text.slice(end, link.start));
        const chip = document.createElement("span");
        chip.textContent = link.text;
        created.push(chip);
        decorate(chip, link.path, link.line);
        fragment.append(chip);
        end = link.end;
      }
      fragment.append(text.slice(end));
      node.replaceWith(fragment);
    }
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file-path]") : null;
      if (!node || !root.contains(node)) return;
      event.preventDefault();
      event.stopPropagation();
      void openFile({ path: node.dataset.filePath! }, {
        context: "ai-file-link", workspaceId: fileOpenWorkspaceForTab(tabId),
        line: node.dataset.fileLine ? Number(node.dataset.fileLine) : undefined,
      }).catch((error) => useAppStore.getState().setStatusMessage(error instanceof Error ? error.message : String(error)));
    };
    root.addEventListener("click", activate, true);
    root.addEventListener("keydown", activate, true);
    return () => {
      root.removeEventListener("click", activate, true);
      root.removeEventListener("keydown", activate, true);
      for (const node of created) node.replaceWith(node.textContent ?? "");
      for (const { node, attributes } of altered) {
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
        for (const [name, value] of attributes) node.setAttribute(name, value);
      }
    };
  }, [rootRef, enabled, content, preferredTerminalTabId]);
}
