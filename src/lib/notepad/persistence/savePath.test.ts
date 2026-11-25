import { describe, expect, it } from "vitest";
import {
  defaultNotepadSavePath,
  notepadDialogDirectory,
  notepadSaveDirectory,
} from "./savePath";

describe("notepadSaveDirectory (U2 default directory)", () => {
  it("prefers a remembered last save directory", () => {
    expect(notepadSaveDirectory("/data/notes", "/home/qa")).toBe("/data/notes");
    expect(notepadSaveDirectory("C:\\Users\\qa\\Documents", "C:\\Users\\qa")).toBe("C:\\Users\\qa\\Documents");
  });

  it("falls back to the home directory when no last directory is known", () => {
    expect(notepadSaveDirectory("", "/preview")).toBe("/preview");
    expect(notepadSaveDirectory(undefined, "C:\\Users\\qa")).toBe("C:\\Users\\qa");
    expect(notepadSaveDirectory(null, null)).toBe("");
  });

  it("trims whitespace and ignores a blank last directory", () => {
    expect(notepadSaveDirectory("  /data/notes  ", "/home/qa")).toBe("/data/notes");
    expect(notepadSaveDirectory("   ", "/preview")).toBe("/preview");
  });

  it("normalizes trailing separators without breaking filesystem roots", () => {
    expect(notepadSaveDirectory("/data/notes/", null)).toBe("/data/notes");
    expect(notepadSaveDirectory("C:\\Users\\qa\\", null)).toBe("C:\\Users\\qa");
    expect(notepadSaveDirectory("/", null)).toBe("/");
    expect(notepadSaveDirectory("C:\\", null)).toBe("C:\\");
  });
});

describe("defaultNotepadSavePath (U2 absolute default path)", () => {
  it("joins a POSIX directory with the platform-specific separator", () => {
    expect(defaultNotepadSavePath("/preview", "新建 1.txt", "linux")).toBe("/preview/新建 1.txt");
    expect(defaultNotepadSavePath("/preview", "新建 1.txt", "macos")).toBe("/preview/新建 1.txt");
    // Browser stub home is POSIX on every host, including Windows QA runs.
    expect(defaultNotepadSavePath("/preview", "新建 1.txt", "windows")).toBe("/preview/新建 1.txt");
  });

  it("joins a Windows directory with backslashes regardless of the host platform", () => {
    expect(defaultNotepadSavePath("C:\\Users\\qa", "notes.txt", "linux")).toBe("C:\\Users\\qa\\notes.txt");
    expect(defaultNotepadSavePath("C:/Users/qa", "notes.txt", "linux")).toBe("C:\\Users\\qa\\notes.txt");
    expect(defaultNotepadSavePath("\\\\server\\share", "notes.txt", "macos")).toBe("\\\\server\\share\\notes.txt");
  });

  it("uses the platform hint only when the directory spelling has no clue", () => {
    expect(defaultNotepadSavePath("notes", "a.txt", "windows")).toBe("notes\\a.txt");
    expect(defaultNotepadSavePath("notes", "a.txt", "unknown")).toBe("notes/a.txt");
    expect(defaultNotepadSavePath("notes", "a.txt", "macos")).toBe("notes/a.txt");
  });

  it("returns the bare file name when the directory is empty and the directory when the name is empty", () => {
    expect(defaultNotepadSavePath("", "untitled.txt", "windows")).toBe("untitled.txt");
    expect(defaultNotepadSavePath("   ", "untitled.txt", "linux")).toBe("untitled.txt");
    expect(defaultNotepadSavePath("/preview", "", "linux")).toBe("/preview");
  });

  it("does not double separators and keeps filesystem roots intact", () => {
    expect(defaultNotepadSavePath("/preview/", "a.txt", "windows")).toBe("/preview/a.txt");
    expect(defaultNotepadSavePath("C:\\Users\\qa\\", "a.txt", "windows")).toBe("C:\\Users\\qa\\a.txt");
    expect(defaultNotepadSavePath("/", "a.txt", "windows")).toBe("/a.txt");
    expect(defaultNotepadSavePath("C:\\", "a.txt", "linux")).toBe("C:\\a.txt");
  });

  it("uses only the file name when the name carries its own path", () => {
    expect(defaultNotepadSavePath("/preview", "draft/新建 1.txt", "linux")).toBe("/preview/新建 1.txt");
    expect(defaultNotepadSavePath("/preview", "draft\\新建 1.txt", "linux")).toBe("/preview/新建 1.txt");
  });
});

describe("notepadDialogDirectory (U2 browse picker directory)", () => {
  it("returns a directory argument that ends with a separator", () => {
    expect(notepadDialogDirectory("/home/qa")).toBe("/home/qa/");
    expect(notepadDialogDirectory("C:\\Users\\qa")).toBe("C:\\Users\\qa\\");
    expect(notepadDialogDirectory("/preview", "windows")).toBe("/preview/");
  });

  it("is idempotent for roots and already-terminated directories", () => {
    expect(notepadDialogDirectory("/")).toBe("/");
    expect(notepadDialogDirectory("C:\\")).toBe("C:\\");
    expect(notepadDialogDirectory("/home/qa/")).toBe("/home/qa/");
    expect(notepadDialogDirectory("")).toBe("");
  });
});
