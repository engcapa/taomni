/* Interactions are in-memory demonstrations, never production execution. */
(function installPrototypeUI() {
  "use strict";
  const { DemoState, clone } = globalThis.TaomniAgentDemo;
  const state = new DemoState();
  const $ = (id) => document.getElementById(id);
  let settingsDraft = null;
  let editingResource = null;
  let toastTimer;

  function notify(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5500);
  }
  function openInspector(tab) {
    $("inspector").hidden = false;
    $("workbench").classList.add("has-inspector");
    $("changes-panel").hidden = tab !== "changes";
    $("sources-panel").hidden = tab !== "sources";
    for (const button of document.querySelectorAll("[data-inspector]")) {
      button.classList.toggle("active", button.dataset.inspector === tab);
    }
  }
  function syncConfigLabels() {
    $("sidebar-default").textContent = state.config.name + " · 全部新任务沿用";
    const effective = state.effectiveConfig();
    $("composer-config").textContent = effective.name;
    $("snapshot-label").textContent = "沿用统一配置 · " + effective.name;
    $("receipt-config").textContent = effective.name + " · revision " + effective.revision;
    $("effective-planner").textContent = effective.planning;
    $("effective-workers").textContent = effective.workers.join(" · ");
    const resource = effective.planning;
    $("recovery-profile").textContent = resource + " · 原任务版本";
  }
  function addTaskEntry(session) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-entry";
    button.dataset.session = session.id;
    const dot = document.createElement("span");
    dot.className = "task-dot hollow";
    const label = document.createElement("span");
    label.className = "task-label";
    label.textContent = session.title;
    button.append(dot, label);
    $("task-list").append(button);
  }
  function renderSession() {
    const session = state.selected;
    const isDraft = !session;
    $("empty-state").hidden = !isDraft;
    $("messages").hidden = isDraft;
    $("workbench").classList.toggle("has-conversation", !isDraft);
    $("conversation-title").textContent = session ? session.title : "新任务";
    for (const button of document.querySelectorAll("[data-session]")) {
      button.classList.toggle("active", button.dataset.session === (session ? session.id : "draft"));
    }
    $("followup-messages").replaceChildren();
    if (session) {
      $("user-goal").textContent = session.goal;
      $("task-mode").value = session.mode;
      const isPartial = session.status === "partial";
      $("partial-card").hidden = !isPartial;
      $("plan-card").hidden = isPartial;
      if (isPartial) $("execution-details").hidden = true;
      $("running-note").hidden = session.status !== "executing";
      const intentSteps = session.mode === "规划"
        ? [["核对目标、规范与现状", "基于选定项目与文档"], ["一次整理设计与接口", "沿用少调用策略，不直接改代码"], ["交付方案与测试计划", "候选不等于实际验证通过"]]
        : session.mode === "审阅"
          ? [["读取变更与相关调用方", "固定候选与基线"], ["审阅正确性与回归风险", "只读检查，不自动修复"], ["列出证据和未决项", "不把静态审阅当测试通过"]]
          : [["确认设置字段与 IPC 契约", "沿用现有状态与错误处理"], ["实现前后端与对应测试", "独立工作区，相关任务协作"], ["验证结果并审阅变更", "提交或合并前仍需你确认"]];
      for (const [index, suffix] of ["one", "two", "three"].entries()) {
        $("step-" + suffix + "-title").textContent = intentSteps[index][0];
        $("step-" + suffix + "-note").textContent = intentSteps[index][1];
      }
      $("running-note").querySelector("span:nth-child(2)").textContent = session.mode === "开发" ? "正在实现与补充测试" : session.mode === "规划" ? "正在整理设计候选" : "正在只读审阅";
      const labels = { planned: "等待确认", executing: "正在开发", paused: "已暂停", candidate: "候选待审阅" };
      $("plan-state").textContent = labels[session.status] || "等待处理";
      $("step-two-status").textContent = session.status === "executing" ? "处理中" : session.status === "candidate" ? "候选已保留" : session.status === "paused" ? "已停止派发" : "待开始";
      $("start-plan").hidden = session.status !== "planned";
      $("agent-intro").textContent = isPartial
        ? "设计和接口两份内容已保存。测试计划输出被截断，前面的候选没有丢失。"
        : session.mode === "规划"
          ? "我会把现状、接口与测试约束一起整理，先交付统一设计，不直接修改代码。"
          : session.mode === "审阅"
            ? "我会基于当前变更和相关调用方做审阅，列出有证据的问题，不修改代码。"
            : "我会先核对现有设置和接口，在独立工作区实现，再运行相关验证。";
      if (session.status === "candidate") {
        $("closing-note").textContent = session.recoveryCalls
          ? "一次补全演示已完成，旧候选保留；仍需审阅，未自动应用或合并。"
          : "这里展示历史候选状态；没有实际运行测试或修改当前仓库。";
      } else {
        $("closing-note").textContent = "沿用任务确认时的统一配置。变更和执行细节按需展开，不会自动提交或合并。";
      }
      for (const message of session.messages) appendFollowUp(message);
    }
    syncConfigLabels();
    $("chat-scroll").scrollTop = 0;
  }
  function appendFollowUp(text) {
    const article = document.createElement("article");
    article.className = "user-message";
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = "你 · 追加说明";
    const body = document.createElement("div");
    body.textContent = text;
    article.append(label, body);
    $("followup-messages").append(article);
  }
  function newTask() {
    state.newDraft();
    $("prompt").value = "";
    $("task-mode").value = "开发";
    $("attachment-chips").hidden = true;
    $("execution-details").hidden = true;
    $("inspector").hidden = true;
    $("workbench").classList.remove("has-inspector");
    renderSession();
    $("prompt").focus();
  }
  function send() {
    const goal = $("prompt").value.trim();
    if (!goal) { notify("先描述目标即可，无需先填写模型或调用参数。"); $("prompt").focus(); return; }
    if (state.selected) {
      state.followUp(goal);
      $("prompt").value = "";
      renderSession();
      $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
      notify("已添加会话说明演示；不会静默改变已确认计划、权限或调用配置。");
      return;
    }
    const session = state.submit(goal, $("task-mode").value);
    addTaskEntry(session);
    $("prompt").value = "";
    renderSession();
    notify("已沿用统一配置创建任务演示，没有调用模型。");
  }

  function showSettingsTab(tab) {
    $("defaults-section").hidden = tab !== "defaults";
    $("resources-section").hidden = tab !== "resources";
    for (const button of document.querySelectorAll("[data-settings-tab]")) {
      button.classList.toggle("active", button.dataset.settingsTab === tab);
    }
  }
  function populateSettings() {
    $("plan-name").value = settingsDraft.name;
    $("planning-resource").value = settingsDraft.planning;
    $("review-resource").value = settingsDraft.review;
    $("worker-claude").checked = settingsDraft.workers.includes("Claude Code");
    $("worker-codex").checked = settingsDraft.workers.includes("Codex");
    $("concurrency").value = String(settingsDraft.concurrency);
    $("one-shot").checked = settingsDraft.oneShot;
  }
  function openSettings() {
    settingsDraft = clone(state.config);
    editingResource = null;
    populateSettings();
    $("resource-editor").hidden = true;
    $("settings-message").textContent = "保存后多个新任务共同使用；当前任务不会被追改";
    showSettingsTab("defaults");
    $("settings-dialog").showModal();
  }
  function captureResourceEdits() {
    if (!editingResource) return;
    const resource = settingsDraft.resources[editingResource];
    resource.address = $("resource-address").value.trim();
    resource.model = $("resource-model").value.trim();
    resource.protocol = $("resource-protocol").value;
    resource.cost = $("resource-cost").value.trim();
  }
  function editResource(name) {
    captureResourceEdits();
    if (name === "claude" || name === "codex") {
      editingResource = null;
      $("resource-editor").hidden = true;
      notify("本机 harness 由官方方式登录；产品实现时检测实际协议能力，原型不会启动 CLI。");
      return;
    }
    editingResource = name;
    const resource = settingsDraft.resources[name];
    $("resource-editor").hidden = false;
    $("resource-name").textContent = resource.name;
    $("resource-address").value = resource.address;
    $("resource-model").value = resource.model;
    $("resource-protocol").value = resource.protocol;
    $("resource-cost").value = resource.cost;
    $("resource-editor").scrollIntoView({ block: "nearest" });
  }
  function saveSettings() {
    captureResourceEdits();
    settingsDraft.name = $("plan-name").value;
    settingsDraft.planning = $("planning-resource").value;
    settingsDraft.review = $("review-resource").value;
    settingsDraft.workers = [];
    if ($("worker-claude").checked) settingsDraft.workers.push("Claude Code");
    if ($("worker-codex").checked) settingsDraft.workers.push("Codex");
    settingsDraft.concurrency = Number($("concurrency").value);
    settingsDraft.oneShot = $("one-shot").checked;
    const result = state.saveConfig(settingsDraft);
    if (result.error) { $("settings-message").textContent = result.error; return; }
    $("settings-dialog").close();
    syncConfigLabels();
    notify("统一配置已保存到本页演示状态；以后多个新任务沿用，旧任务仍保留原版本。刷新不保留演示修改。");
  }
  function selectDemo(name) {
    if (name === "new") return newTask();
    if (name === "settings") return openSettings();
    state.select(name === "partial" ? "partial" : "settings-feature");
    $("prompt").value = "";
    $("execution-details").hidden = true;
    renderSession();
  }

  for (const button of document.querySelectorAll(".new-task")) button.onclick = newTask;
  for (const button of document.querySelectorAll(".open-settings")) button.onclick = openSettings;
  for (const button of document.querySelectorAll("[data-demo]")) button.onclick = () => selectDemo(button.dataset.demo);
  for (const button of document.querySelectorAll("[data-inspector]")) button.onclick = () => openInspector(button.dataset.inspector);
  for (const button of document.querySelectorAll("[data-settings-tab]")) button.onclick = () => showSettingsTab(button.dataset.settingsTab);
  for (const button of document.querySelectorAll("[data-resource]")) button.onclick = () => editResource(button.dataset.resource);
  for (const button of document.querySelectorAll("[data-suggestion]")) button.onclick = () => {
    $("prompt").value = button.dataset.suggestion;
    $("task-mode").value = button.dataset.mode;
    $("prompt").focus();
  };
  for (const button of document.querySelectorAll("[data-artifact]")) button.onclick = () => {
    openInspector("changes");
    $("artifact-title").textContent = button.dataset.artifact + " · 设计候选示意";
    notify("右侧展示候选结构；未读取真实文档、未写磁盘。");
  };
  $("task-list").onclick = (event) => {
    const button = event.target.closest("[data-session]");
    if (!button) return;
    if (button.dataset.session === "draft") return newTask();
    state.select(button.dataset.session);
    $("prompt").value = "";
    $("execution-details").hidden = true;
    renderSession();
  };
  $("send").onclick = send;
  $("prompt").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  };
  $("show-sources").onclick = () => openInspector("sources");
  $("composer-context").onclick = () => openInspector("sources");
  $("show-changes").onclick = () => openInspector("changes");
  $("close-inspector").onclick = () => { $("inspector").hidden = true; $("workbench").classList.remove("has-inspector"); };
  $("activity-toggle").onclick = () => { $("execution-details").hidden = !$("execution-details").hidden; };
  $("start-plan").onclick = () => { if (state.startPlan()) { renderSession(); notify("演示：计划确认后开始执行；没有实际启动 worker 或修改代码。"); } };
  $("stop-task").onclick = () => { if (state.stop()) { renderSession(); notify("仅演示暂停状态；产品须等待实际进程停止，不能立即假报已清理。"); } };
  $("attach-file").onclick = () => { $("attachment-chips").hidden = false; notify("已添加演示附件；正式实现需用户选择文件并进行出站校验。"); };
  $("remove-attachment").onclick = () => { $("attachment-chips").hidden = true; };
  $("close-settings").onclick = () => $("settings-dialog").close();
  $("cancel-settings").onclick = () => $("settings-dialog").close();
  $("save-settings").onclick = saveSettings;
  $("settings-dialog").addEventListener("close", () => { settingsDraft = null; editingResource = null; });
  $("add-resource").onclick = () => notify("资源一次添加、多任务复用。此稿演示已配置资源的编辑，未实现真实连接或安装。");
  $("recovery-request").onclick = () => { if (state.selected?.status === "partial") $("recovery-dialog").showModal(); };
  $("dismiss-recovery").onclick = () => $("recovery-dialog").close();
  $("confirm-recovery").onclick = () => {
    if (!state.recover()) return;
    $("recovery-dialog").close();
    renderSession();
    notify("一次补全演示完成；候选仍未应用，统一配置没有改变，也未发送真实请求。");
  };
  $("toggle-sidebar").onclick = () => {
    if (innerWidth <= 760) document.body.classList.toggle("sidebar-open");
    else document.body.classList.toggle("sidebar-collapsed");
  };
  $("sidebar-search").onclick = () => { $("task-search").hidden = !$("task-search").hidden; if (!$("task-search").hidden) $("task-search").focus(); };
  $("task-search").oninput = () => {
    const query = $("task-search").value.trim();
    for (const button of document.querySelectorAll(".task-entry")) button.hidden = !button.textContent.includes(query);
  };
  $("review-changes").onclick = () => notify("正式实现将打开同一候选的完整 diff；当前没有实际修改、验证或接受。");
  $("other-project").onclick = () => notify("示意另一个项目。全局默认配置可跨项目复用；实际发送前仍按项目授权和快照隔离。");
  $("select-project").onclick = () => notify("项目选择是任务上下文，不是重新配置模型。原型固定为 taomni。");
  $("demo-state").onclick = () => selectDemo(state.selected ? "new" : "conversation");
  const initial = new URLSearchParams(location.search).get("view");
  renderSession();
  if (["conversation", "partial", "settings"].includes(initial)) selectDemo(initial);
  if (initial === "changes") { selectDemo("conversation"); openInspector("changes"); }
})();
