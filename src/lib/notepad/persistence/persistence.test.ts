import { beforeEach, describe, expect, it, vi } from "vitest";

const backups = vi.hoisted(() => new Map<string, { content: string; name: string }>());

vi.mock("../ipc", async (original) => {
  const actual = await original<typeof import("../ipc")>();
  return {
    ...actual,
    notepadBackupWrite: vi.fn(async (args) => {
      backups.set(args.docId, { content: args.content, name: args.name });
      return {
        id: `${args.docId}__1`,
        docId: args.docId,
        path: args.path,
        name: args.name,
        encoding: args.encoding,
        bom: args.bom,
        eol: args.eol,
        savedHash: args.savedHash,
        updatedAt: 1000,
        size: args.content.length,
      };
    }),
    notepadBackupPrune: vi.fn(async (docId: string) => {
      backups.delete(docId);
    }),
  };
});

import { NotepadBackupManager } from "./backupManager";
import { DRAFTS_MIGRATED_KEY, LEGACY_VIEWER_DRAFTS_KEY, migrateLegacyViewerDrafts } from "./draftMigration";
import { parseSession, serializeSession } from "./sessionManager";
import { buildPrintableHtml } from "../print/printDocument";

describe("notepad persistence & print (V-02, V-28, V-29)", () => {
  beforeEach(() => {
    localStorage.clear();
    backups.clear();
  });

  it("flushes dirty document backups and prunes cleanly on save (V-02)", async () => {
    const states: string[] = [];
    const mgr = new NotepadBackupManager((_doc, s) => states.push(s));
    const entry = await mgr.flushSnapshot({
      docId: "untitled:1",
      path: null,
      name: "新建 1",
      content: "unsaved text",
      encoding: "UTF-8",
      bom: false,
      eol: "LF",
      savedHash: "",
      dirty: true,
    });
    expect(entry?.docId).toBe("untitled:1");
    expect(backups.get("untitled:1")?.content).toBe("unsaved text");
    expect(states).toEqual(["saving", "saved"]);

    await mgr.pruneDoc("untitled:1");
    expect(backups.has("untitled:1")).toBe(false);
    expect(states.at(-1)).toBe("idle");
    mgr.dispose();
  });

  it("migrates legacy taomni.viewer.drafts.v1 entries once on startup (V-28)", async () => {
    localStorage.setItem(
      LEGACY_VIEWER_DRAFTS_KEY,
      JSON.stringify({
        "/preview/notes.txt": { content: "legacy text draft", baseHash: "h1", eol: "LF", encoding: "UTF-8", bom: false },
      }),
    );
    const count = await migrateLegacyViewerDrafts();
    expect(count).toBe(1);
    expect(backups.get("/preview/notes.txt")?.content).toBe("legacy text draft");
    expect(localStorage.getItem(LEGACY_VIEWER_DRAFTS_KEY)).toBeNull();
    expect(localStorage.getItem(DRAFTS_MIGRATED_KEY)).toBe("1");

    // Second run is a strict no-op
    expect(await migrateLegacyViewerDrafts()).toBe(0);
  });

  it("serializes and parses SessionFileV1 without leaking Mark rules (V-29)", () => {
    const json = serializeSession(
      [
        {
          docKey: "/tmp/a.txt",
          path: "/tmp/a.txt",
          untitled: false,
          name: "a.txt",
          pinned: true,
          encoding: "UTF-8",
          bom: false,
          eol: "CRLF",
          cursorLine: 4,
          cursorCol: 9,
          scrollTop: 120,
          bookmarks: [1, 3],
          wrap: true,
          readOnly: false,
          split: false,
        },
      ],
      "/tmp/a.txt",
    );
    expect(json).not.toContain('"marks"');
    const parsed = parseSession(json);
    expect(parsed.version).toBe(1);
    expect(parsed.tabs[0]).toMatchObject({ pinned: true, eol: "CRLF", cursorLine: 4, bookmarks: [1, 3] });
  });

  it("builds safe HTML for print preview with line numbers and escaped tags", () => {
    const html = buildPrintableHtml({
      title: "a.txt",
      content: "<script>alert(1)</script>\nsecond line",
      settings: { range: "all", lineNumbers: true, marginMm: 15, header: "{name}", footer: "P{page}", colorMode: "bw" },
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<span class="ln">2</span>');
  });
});
