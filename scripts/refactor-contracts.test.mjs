import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { nativeRoutes } from "./refactor-contracts.mjs";

test("route extraction follows central and delegated exact arms", () => {
  const errors = [];
  const routes = nativeRoutes([
    '"read" | "write" => files::handle(invoke),',
    '"chat_send" | "chat_stream" => { super::chat::handle(invoke) }',
    '"orchestration_create_run" => super::orchestration::handle(invoke),',
  ], errors);
  assert.deepEqual([...routes], [["read", "files"], ["write", "files"], ["chat_send", "chat"], ["chat_stream", "chat"], ["orchestration_create_run", "orchestration"]]);
  assert.deepEqual(errors, []);
});

test("duplicate delegated ownership still fails rather than overwriting silently", () => {
  const errors = [];
  nativeRoutes(['"chat_send" => chat::handle(invoke),', '"chat_send" => super::agent::handle(invoke),'], errors);
  assert.deepEqual(errors, ["Duplicate native route: chat_send"]);
});

test("the live delegate owns every AI command it routes", () => {
  const root = new URL("../src-tauri/src/commands/", import.meta.url);
  const source = fs.readFileSync(new URL("ai_routes.rs", root), "utf8");
  const owner = source.slice(0, source.indexOf("pub(super) fn handle"));
  const names = new Set([...owner.matchAll(/"(\w+)"/g)].map((match) => match[1]));
  const routes = nativeRoutes([source]);
  for (const command of routes.keys()) assert.ok(names.has(command) || (command.startsWith("orchestration_") && owner.includes('command.starts_with("orchestration_")')), command);
  const dispatcher = fs.readFileSync(new URL("mod.rs", root), "utf8");
  assert.match(dispatcher, /if ai_routes::owns\(invoke.message.command\(\)\)\s*\{\s*return ai_routes::handle\(invoke\);/);
});
