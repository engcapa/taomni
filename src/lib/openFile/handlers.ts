import { fileExtension } from "./classifyFile";
import { officialDocumentFormats } from "./documentFormats";
import type { FileHandler } from "./preferences";

export const OFFICE_EXTENSIONS = new Set(officialDocumentFormats.keys());

export interface FileHandlerDescriptor {
  id: FileHandler;
  labelZh: string;
  labelEn: string;
  inDevelopment?: boolean;
  available: () => boolean;
  supportsExtension?: (extension: string) => boolean;
  open?: (path: string) => Promise<void>;
}

export class UnavailableFileHandlerError extends Error {
  readonly handlerId: FileHandler;
  readonly handlerLabel: string;
  readonly filePath: string;

  constructor(handlerId: FileHandler, handlerLabel: string, filePath: string) {
    super(`unavailable_handler:${handlerId}: ${handlerLabel} is currently unavailable (in development) for ${filePath}`);
    this.name = "UnavailableFileHandlerError";
    this.handlerId = handlerId;
    this.handlerLabel = handlerLabel;
    this.filePath = filePath;
  }
}

export function isOfficeExtension(pathOrExtension: string): boolean {
  const ext = pathOrExtension.includes(".") || pathOrExtension.includes("/") || pathOrExtension.includes("\\")
    ? fileExtension(pathOrExtension)
    : pathOrExtension.toLowerCase().replace(/^\./, "");
  return OFFICE_EXTENSIONS.has(ext);
}

const registry = new Map<FileHandler, FileHandlerDescriptor>([
  [
    "system",
    {
      id: "system",
      labelZh: "系统默认应用",
      labelEn: "System default app",
      available: () => true,
    },
  ],
  [
    "workspace",
    {
      id: "workspace",
      labelZh: "Code editor",
      labelEn: "Code editor",
      available: () => true,
    },
  ],
  [
    "notepad",
    {
      id: "notepad",
      labelZh: "Notepad",
      labelEn: "Notepad",
      available: () => true,
    },
  ],
  [
    "taomni",
    {
      id: "taomni",
      labelZh: "Taomni 默认打开",
      labelEn: "Taomni default",
      available: () => true,
    },
  ],
  [
    "taoffice",
    {
      id: "taoffice",
      labelZh: "TaOffice",
      labelEn: "TaOffice",
      available: () => true,
      supportsExtension: (ext) => OFFICE_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, "")),
    },
  ],
]);

export function registerFileHandler(descriptor: FileHandlerDescriptor): void {
  registry.set(descriptor.id, descriptor);
}

export function getFileHandler(id: FileHandler): FileHandlerDescriptor | undefined {
  return registry.get(id);
}

export function listFileHandlers(extension?: string): FileHandlerDescriptor[] {
  const normalized = extension?.toLowerCase().replace(/^\./, "");
  return Array.from(registry.values()).filter((handler) => {
    if (!normalized || !handler.supportsExtension) return true;
    return handler.supportsExtension(normalized);
  });
}

export function isHandlerAvailable(id: FileHandler): boolean {
  return registry.get(id)?.available() ?? false;
}
