import { useEffect, useState } from "react";
import {
  createOpenFileTodoScanner,
  sameWorkspaceTodoItems,
  type WorkspaceTodoItem,
} from "./todoBookmarks";

interface TodoOpenFile {
  key: string;
  path: string;
  subtitle?: string;
  text: string;
}

/**
 * TODO markers are useful navigation chrome, but scanning every open buffer on
 * the synchronous editor update path makes an ordinary keystroke proportional
 * to the size of every open file.  Keep the last result while the user is
 * typing, then rescan only after the buffer has been idle briefly.
 */
export function useDeferredOpenFileTodos(
  openFiles: Readonly<Record<string, TodoOpenFile>>,
  delayMs = 500,
): WorkspaceTodoItem[] {
  const [scanner] = useState(createOpenFileTodoScanner);
  const [todos, setTodos] = useState<WorkspaceTodoItem[]>(() => scanner.scan(Object.values(openFiles).map((file) => ({
    key: file.key,
    pathLabel: file.subtitle || file.path,
    text: file.text,
  }))));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = scanner.scan(Object.values(openFiles).map((file) => ({
        key: file.key,
        pathLabel: file.subtitle || file.path,
        text: file.text,
      })));
      setTodos((current) => (sameWorkspaceTodoItems(current, next) ? current : next));
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, openFiles, scanner]);

  return todos;
}
