/* Local prototype state only. No network, credentials or browser storage. */
(function installPrototypeModel(root) {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const defaultConfig = () => ({
    revision: 1,
    name: "日常开发",
    planning: "长上下文 API",
    workers: ["Claude Code", "Codex"],
    review: "开发 API",
    concurrency: 2,
    oneShot: true,
    resources: {
      long: { name: "长上下文 API", address: "https://your-provider.example/v1", model: "your-model-id", protocol: "Anthropic Messages", cost: "1.0" },
      daily: { name: "开发 API", address: "https://your-provider.example/v1", model: "your-model-id", protocol: "OpenAI Responses", cost: "1.0" }
    }
  });
  function validateConfig(config) {
    if (typeof config.name !== "string" || !config.name.trim() || config.name.trim().length > 24) return "请为默认方案填写 1–24 字的名称。";
    if (!Array.isArray(config.workers) || !config.workers.length) return "至少保留一个开发 worker；不可用时产品应明确阻塞，不静默替换。";
    if (![1, 2, 3].includes(Number(config.concurrency))) return "请选择 1–3 个演示并发 worker。";
    for (const resource of Object.values(config.resources)) {
      if (!Number.isFinite(Number(resource.cost)) || Number(resource.cost) <= 0) return "成本系数需为大于 0 的有限数值。";
      if (!resource.address.startsWith("https://") && !resource.address.startsWith("http://127.0.0.1")) return "演示连接请使用 HTTPS 或明确的本机地址；不会实际连接。";
    }
    return null;
  }
  class DemoState {
    constructor() {
      this.config = defaultConfig();
      this.selectedId = null;
      this.nextId = 1;
      this.sessions = new Map([
        ["settings-feature", this.sample("settings-feature", "项目设置与接口实现", "为项目设置增加新选项，完成接口、实现与测试。", "开发", "planned")],
        ["partial", this.sample("partial", "整理开发任务编排方案", "整理开发任务编排方案，统一接口与测试计划。", "规划", "partial")],
        ["terminal-fix", this.sample("terminal-fix", "终端布局与焦点修复", "修复终端布局和焦点问题，检查相关回归。", "开发", "candidate")]
      ]);
    }
    sample(id, title, goal, mode, status) {
      return { id, title, goal, mode, status, settingsSnapshot: clone(this.config), recoveryCalls: 0, messages: [] };
    }
    get selected() { return this.selectedId ? this.sessions.get(this.selectedId) : null; }
    newDraft() { this.selectedId = null; }
    select(id) {
      if (!this.sessions.has(id)) throw new Error("Unknown prototype session");
      this.selectedId = id;
      return this.selected;
    }
    submit(goal, mode) {
      const text = String(goal || "").trim();
      if (!text) return null;
      if (!["开发", "规划", "审阅"].includes(mode)) throw new Error("Unknown task intent");
      const id = "demo-task-" + this.nextId++;
      const session = this.sample(id, text.slice(0, 16), text, mode, "planned");
      this.sessions.set(id, session);
      this.selectedId = id;
      return session;
    }
    followUp(text) {
      if (!this.selected || !String(text).trim()) return false;
      this.selected.messages.push(String(text).trim());
      return true;
    }
    startPlan() {
      if (!this.selected || this.selected.status !== "planned") return false;
      this.selected.status = "executing";
      return true;
    }
    stop() {
      if (!this.selected || this.selected.status !== "executing") return false;
      this.selected.status = "paused";
      return true;
    }
    recover() {
      if (!this.selected || this.selected.status !== "partial" || this.selected.recoveryCalls !== 0) return false;
      this.selected.recoveryCalls = 1;
      this.selected.status = "candidate";
      return true;
    }
    saveConfig(draft) {
      const error = validateConfig(draft);
      if (error) return { error };
      this.config = { ...clone(draft), name: draft.name.trim(), revision: this.config.revision + 1 };
      return { revision: this.config.revision };
    }
    effectiveConfig() { return clone(this.selected ? this.selected.settingsSnapshot : this.config); }
  }
  root.TaomniAgentDemo = { DemoState, defaultConfig, validateConfig, clone };
})(globalThis);
