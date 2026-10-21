import { type LspDocumentDescriptor } from "./types";

export function documentArgs(descriptor: LspDocumentDescriptor) {
  return {
    workspaceId: descriptor.workspaceId,
    rootPath: descriptor.rootPath ?? null,
    filePath: descriptor.filePath,
    documentUri: descriptor.documentUri?.trim() || null,
    languageId: descriptor.languageId ?? null,
    serverCommandId: descriptor.serverCommandId ?? null,
    customServerCommand: descriptor.customServerCommand ?? null,
    javaHome: descriptor.javaHome?.trim() || null,
  };
}
