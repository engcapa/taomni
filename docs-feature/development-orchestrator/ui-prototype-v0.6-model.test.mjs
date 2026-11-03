import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./ui-prototype-v0.6-model.js", import.meta.url), "utf8");
function createModel() {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.TaomniAgentDemo;
}

test("multiple tasks use the same shared configuration without per-task setup", () => {
  const { DemoState } = createModel();
  const state = new DemoState();
  const first = state.submit("实现设置功能", "开发");
  state.newDraft();
  const second = state.submit("审阅相关变更", "审阅");
  assert.equal(first.settingsSnapshot.revision, 1);
  assert.equal(second.settingsSnapshot.revision, 1);
  assert.equal(first.settingsSnapshot.name, second.settingsSnapshot.name);
  assert.equal(first.settingsSnapshot.planning, "长上下文 API");
  assert.deepEqual([...second.settingsSnapshot.workers], ["Claude Code", "Codex"]);
  assert.equal(state.config.revision, 1);
});

test("saving shared defaults affects future tasks, not previously submitted tasks", () => {
  const { DemoState, clone } = createModel();
  const state = new DemoState();
  const old = state.submit("已有任务", "开发");
  state.startPlan();
  const draft = clone(state.config);
  draft.name = "团队开发";
  draft.planning = "开发 API";
  draft.workers = ["Claude Code"];
  const result = state.saveConfig(draft);
  assert.equal(result.revision, 2);
  assert.equal(old.status, "executing");
  assert.equal(old.settingsSnapshot.name, "日常开发");
  assert.equal(state.effectiveConfig().revision, 1);
  state.newDraft();
  const fresh = state.submit("后续任务", "规划");
  assert.equal(fresh.settingsSnapshot.name, "团队开发");
  assert.equal(fresh.settingsSnapshot.revision, 2);
  assert.equal(fresh.settingsSnapshot.planning, "开发 API");
  assert.deepEqual([...fresh.settingsSnapshot.workers], ["Claude Code"]);
});

test("unsaved settings are isolated from shared defaults and task snapshots", () => {
  const { DemoState, clone } = createModel();
  const state = new DemoState();
  const first = state.submit("同一目标", "开发");
  const draft = clone(state.config);
  draft.name = "未保存方案";
  draft.resources.long.cost = "8";
  assert.equal(state.config.name, "日常开发");
  assert.equal(first.settingsSnapshot.resources.long.cost, "1.0");
  const exposed = state.effectiveConfig();
  exposed.resources.long.model = "changed-outside";
  assert.equal(first.settingsSnapshot.resources.long.model, "your-model-id");
});

test("task intent and follow-up messages do not modify global routing", () => {
  const { DemoState } = createModel();
  const state = new DemoState();
  const session = state.submit("先做统一设计", "规划");
  state.followUp("加上迁移风险，但不扩大权限");
  assert.equal(session.mode, "规划");
  assert.equal(session.messages.length, 1);
  assert.equal(state.config.revision, 1);
  assert.equal(state.config.oneShot, true);
  assert.equal(state.startPlan(), true);
  assert.equal(state.startPlan(), false);
  assert.equal(state.stop(), true);
  assert.equal(state.stop(), false);
});

test("invalid settings do not silently erase workers or accept bad cost values", () => {
  const { DemoState, clone } = createModel();
  const state = new DemoState();
  const noWorkers = clone(state.config);
  noWorkers.workers = [];
  assert.ok(state.saveConfig(noWorkers).error);
  const badCost = clone(state.config);
  badCost.resources.long.cost = "NaN";
  assert.ok(state.saveConfig(badCost).error);
  const emptyName = clone(state.config);
  emptyName.name = "   ";
  assert.ok(state.saveConfig(emptyName).error);
  assert.equal(state.config.revision, 1);
});

test("partial recovery is explicit, single-use and does not change shared settings", () => {
  const { DemoState } = createModel();
  const state = new DemoState();
  state.select("partial");
  const before = JSON.stringify(state.config);
  assert.equal(state.selected.recoveryCalls, 0);
  assert.equal(state.recover(), true);
  assert.equal(state.selected.recoveryCalls, 1);
  assert.equal(state.selected.status, "candidate");
  assert.equal(state.recover(), false);
  assert.equal(JSON.stringify(state.config), before);
  assert.notEqual(state.selected.status, "accepted");
});

test("empty requests are rejected and returning to draft does not cancel work", () => {
  const { DemoState } = createModel();
  const state = new DemoState();
  assert.equal(state.submit("   ", "开发"), null);
  const session = state.submit("检查后台生命周期", "开发");
  state.startPlan();
  state.newDraft();
  assert.equal(state.selected, null);
  assert.equal(session.status, "executing");
  state.select(session.id);
  assert.equal(state.selected.status, "executing");
});
