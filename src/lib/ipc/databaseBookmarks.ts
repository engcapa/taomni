import { invoke } from "@tauri-apps/api/core";

// --- Database SQL Bookmarks ---

export interface DbBookmark {
  id: string;
  name: string;
  sqlContent: string;
  remarks?: string;
  tags: string[];
  engine: string;
  databaseName?: string;
  createdAt: number;
  updatedAt: number;
}

export async function dbListBookmarks(engine?: string): Promise<DbBookmark[]> {
  return invoke<DbBookmark[]>("db_list_bookmarks", { engine: engine ?? null });
}

export async function dbSaveBookmark(bookmark: DbBookmark): Promise<void> {
  return invoke<void>("db_save_bookmark", { bookmark });
}

export async function dbDeleteBookmark(id: string): Promise<void> {
  return invoke<void>("db_delete_bookmark", { id });
}
