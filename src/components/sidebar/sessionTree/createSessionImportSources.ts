import type { SessionConfig } from "../../../lib/ipc";
import { readDbeaverCredentialsForDataSources, readFileBytes, readPlistSessionFile, scanLocalSessionFiles, selectFilePath } from "../../../lib/ipc";
import {
  parseDbeaverSessions,
  parseNavicatSessions,
  parseXshellZipSessions,
  parseXshellFile,
  createSessionImportResult,
  type SessionImportOptions,
  type SessionImportResult,
} from "../../../lib/sessionImportExport";
import { parseOpenSshConfig } from "../../../lib/quickConnect";
import { openBinaryFile, openTextFileWithName } from "../../../lib/fileHelpers";
import { normalizeGroupPath, toStoredGroupPath } from "../../../lib/sessionPaths";
import { type TextSessionParser } from "./model";


export interface CreateSessionImportSourcesContext {
  sessions: SessionConfig[];
  queueImportPreview: (result: SessionImportResult, folderPath: string | null, source: string) => void;
  setStatusMessage: (message: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
}

export function createSessionImportSources(context: CreateSessionImportSourcesContext) {
  const { sessions, queueImportPreview, setStatusMessage, t } = context;

  const mergeImportResults = (results: SessionImportResult[]): SessionImportResult =>
    createSessionImportResult(results.flatMap((result) => result.sessions), {
      existingSessions: sessions,
      warnings: results.flatMap((result) => result.warnings),
      skipped: results.reduce((sum, result) => sum + result.skipped, 0),
      secrets: results.flatMap((result) => result.secrets),
      secureCrtPasswords: results.flatMap((result) => result.secureCrtPasswords ?? []),
      externalVault: results.find((result) => result.externalVault)?.externalVault,
      externalSecretsTool: results.some((result) => result.externalSecretsTool === "securecrt")
        ? "securecrt"
        : results.find((result) => result.externalSecretsTool)?.externalSecretsTool,
    });

  const retargetImportedSessions = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    defaultSubfolder: string | null,
  ): SessionConfig[] => imported.map((session) => {
    const target = normalizeGroupPath(folderPath);
    const importedFolder = normalizeGroupPath(session.group_path) ?? normalizeGroupPath(defaultSubfolder);
    const groupPath = target && importedFolder
      ? `${target} / ${importedFolder}`
      : target ?? importedFolder;
    return { ...session, group_path: toStoredGroupPath(groupPath) };
  });

  const queueSessionListImport = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    source: string,
    defaultSubfolder: string | null,
  ) => {
    const result = createSessionImportResult(
      retargetImportedSessions(imported, folderPath, defaultSubfolder),
      { existingSessions: sessions },
    );
    queueImportPreview(result, folderPath, source);
  };

  const importBackendSessions = (
    folderPath: string | null,
    source: string,
    load: () => Promise<SessionConfig[]>,
    defaultSubfolder: string,
  ) => {
    load().then((imported) => {
      if (imported.length === 0) {
        setStatusMessage(t("sessionTree.noSessionsFound", { source }));
        return;
      }
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importTextSessions = (
    folderPath: string | null,
    source: string,
    accept: string,
    parser: TextSessionParser,
    extraOptions?: () => Partial<SessionImportOptions>,
  ) => {
    openTextFileWithName(accept).then((file) => {
      if (!file) return;
      const result = parser(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.name,
        ...(extraOptions?.() ?? {}),
      });
      queueImportPreview(result, folderPath, source);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const dbeaverCredentialOptions = async (path: string): Promise<Partial<SessionImportOptions>> => {
    const credentials = await readDbeaverCredentialsForDataSources(path);
    return Object.keys(credentials).length > 0 ? { dbeaverCredentials: credentials } : {};
  };

  const importNavicatFile = (folderPath: string | null) => {
    openTextFileWithName(".ncx,.xml,text/xml,application/xml").then(async (file) => {
      if (!file) return;
      const result = await parseNavicatSessions(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.name,
      });
      queueImportPreview(result, folderPath, "Navicat");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importDbeaverFile = (folderPath: string | null) => {
    selectFilePath().then(async (path) => {
      if (!path) return;
      const text = new TextDecoder().decode(await readFileBytes(path));
      const result = parseDbeaverSessions(text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: path,
        ...(await dbeaverCredentialOptions(path)),
      });
      queueImportPreview(result, folderPath, "DBeaver");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedDbeaverSessions = (folderPath: string | null) => {
    scanLocalSessionFiles("dbeaver").then(async (files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noLocalConfigFound", { source: "DBeaver" }));
        return;
      }
      const results = await Promise.all(files.map(async (file) =>
        parseDbeaverSessions(file.text, {
          targetFolder: folderPath,
          existingSessions: sessions,
          sourcePath: file.relativePath || file.path,
          ...(await dbeaverCredentialOptions(file.path)),
        }),
      ));
      const result = mergeImportResults(results);
      queueImportPreview(result, folderPath, "DBeaver local config");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importXshellFile = (folderPath: string | null) => {
    openBinaryFile(".xsh,.xts,.zip,application/zip,application/x-zip-compressed,text/plain").then(async (bytes) => {
      if (!bytes) return;
      const result = await parseXshellFile(bytes, {
        targetFolder: folderPath,
        existingSessions: sessions,
      });
      queueImportPreview(result, folderPath, "Xshell");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importXshellZip = (folderPath: string | null) => {
    openBinaryFile(".zip,.xts,application/zip,application/x-zip-compressed").then(async (bytes) => {
      if (!bytes) return;
      const result = await parseXshellZipSessions(bytes, {
        targetFolder: folderPath,
        existingSessions: sessions,
      });
      queueImportPreview(result, folderPath, "Xshell ZIP");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedTextSessions = (
    folderPath: string | null,
    scanKey: string,
    source: string,
    parser: TextSessionParser,
    extraOptions?: () => Partial<SessionImportOptions>,
  ) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noLocalConfigFound", { source }));
        return;
      }
      const extra = extraOptions?.() ?? {};
      const result = mergeImportResults(files.map((file) =>
        parser(file.text, {
          targetFolder: folderPath,
          sourcePath: file.relativePath || file.path,
          ...extra,
        }),
      ));
      queueImportPreview(result, folderPath, `${source} local config`);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importPlistSessions = (
    folderPath: string | null,
    source: string,
    parser: TextSessionParser,
  ) => {
    selectFilePath().then(async (path) => {
      if (!path) return;
      const file = await readPlistSessionFile(path);
      const result = parser(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.relativePath || file.path,
      });
      queueImportPreview(result, folderPath, source);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importOpenSshText = (folderPath: string | null, source: string, defaultSubfolder: string) => {
    openTextFileWithName(".ssh_config,.conf,.config,.txt,text/plain").then((file) => {
      if (!file) return;
      const imported = parseOpenSshConfig(file.text).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedOpenSsh = (folderPath: string | null, scanKey: string, source: string, defaultSubfolder: string) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(t("sessionTree.noOpenSshFound", { source }));
        return;
      }
      const imported = files.flatMap((file) => parseOpenSshConfig(file.text)).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, `${source} local export`, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const showTermiusGuide = () => {
    window.alert(t("sessionTree.termiusGuide"));
  };

  const tabbySecretImportOptions = (): Partial<SessionImportOptions> => ({
    includeSecrets: window.confirm(t("sessionTree.tabbyConfirmTitle")),
  });

  const unavailable = (label: string) => {
    setStatusMessage(t("sessionTree.notImplementedYet", { label }));
  };
  return { importBackendSessions, importXshellFile, importXshellZip, importScannedTextSessions, importTextSessions, tabbySecretImportOptions, importNavicatFile, importDbeaverFile, importScannedDbeaverSessions, importPlistSessions, showTermiusGuide, importOpenSshText, importScannedOpenSsh, unavailable };
}
