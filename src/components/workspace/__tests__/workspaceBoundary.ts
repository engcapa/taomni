/** Filesystem/service doubles for mounted shared-editor tests. */
export const workspaceBoundary = {
  files: new Map<string, string>(),
  directories: new Set<string>(),
  reset() {
    this.files = new Map([["README.md", "# workspace\n"], ["src/index.ts", "export const value = 1;\n"]]);
    this.directories = new Set(["src"]);
  },
  async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const path = String(args.path ?? "");
    const file = (text: string) => ({ path, text, hash: "hash", size: text.length, mtime: 0, encoding: "utf-8", bom: false });
    if (command === "workspace_read_file") {
      const text = workspaceBoundary.files.get(path);
      if (text === undefined) throw new Error(`No such file: ${path}`);
      return file(text);
    }
    if (command === "workspace_create_file") {
      const text = String(args.contents ?? "");
      workspaceBoundary.files.set(path, text);
      return file(text);
    }
    if (command === "workspace_create_dir") workspaceBoundary.directories.add(path);
    if (command === "workspace_list_dir" || command === "workspace_list_files_recursive") {
      const entry = (item: string, directory: boolean) => ({
        name: item.split("/").pop(), path: item, fileType: directory ? "dir" : "file", size: 0, mtime: 0, isHidden: false,
      });
      const inDirectory = (item: string) => item.slice(0, Math.max(0, item.lastIndexOf("/"))) === path;
      if (command === "workspace_list_files_recursive") return [...workspaceBoundary.files.keys()].map((item) => entry(item, false));
      return [...[...workspaceBoundary.directories].filter(inDirectory).map((item) => entry(item, true)),
        ...[...workspaceBoundary.files.keys()].filter(inDirectory).map((item) => entry(item, false))];
    }
    if (command === "workspace_detect_git_roots" || command === "lsp_detect_servers") return [];
    return null;
  },
};
