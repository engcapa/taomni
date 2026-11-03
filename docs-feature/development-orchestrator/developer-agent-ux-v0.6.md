# v0.6 重建：开发 Agent 主界面与跨任务统一配置

- 状态：**用户已查看并接受v0.6原型；本轮完成设计同步、英文详细提交并push后等待，不进行产品实现或CI执行。**
- 来源：用户指出v0.4太复杂、偏离开发agent主界面，要求类似ZCode风格、简化配置、统一配置供多个任务使用。
- 本稿是v0.6 **重建版**，不是找回丢失版本。v0.4保留作历史，但不再作为当前UI实施基准。
- 分支：`feat/development-orchestrator`；基线当前`0c350c0db`。原有review中的八表、分帧、Bootstrap、权限与候选门仍有效；前台复杂度不应由后台复杂度决定。

## 1. 设计方向：开发会话，而不是调度控制台

**用户常规路径：选择项目 → 描述目标 → 发送 → 看计划 / 进展 / 变更。**

不再把“新建API合包”“运行与计划”“协议 / 费用 / 预算表单”作为主界面结构。主产品叫开发Agent，编排是其执行能力；scheduler / pack / ledger等内部对象不要求用户每次理解和填写。

| 区域 | 主要内容 | 不常驻的内容 |
| --- | --- | --- |
| 左侧 | 按项目分组的任务 / 会话、新任务、搜索 | 不再另设调度表 / 全局运行矩阵 |
| 中间 | 新任务输入；会话、计划、执行摘要、候选链接 | 协议、费用算式、NDJSON、attempt ID |
| 输入框 | 项目 / 分支、目标、文件引用、开发 / 规划 / 审阅意图、默认方案摘要 | 每任务资源配置页、必须完成的调用向导 |
| 右侧（按需） | 文件变更 / diff、上下文正文与来源 | 不默认占一列展示预算和资源明细 |
| 左下角设置 | 统一开发配置：默认方案 + 执行资源 | 不为每个任务重新建配置副本 |

深色、安静边框、较少卡片、紧凑项目列表、宽对话正文与底部composer。保留Taomni自己的标识和现有主导航关系，不复制ZCode商标 / 源代码 / 私有资源，也不把参考产品的Full Access当默认权限。

## 2. ZCode参考证据

本轮重新访问官方仓库和官方截图，而不是只靠文字猜测：

- [ZCode源码](https://github.com/zai-org/ZCode/tree/a9fe401eede6e6e5e01be9048679c206fe6f02d9)，2026-11-03快照。
- [Task & File Management](https://zcode.z.ai/en/docs/task-management)：项目 / 任务列表、文件树和按需预览。
- [文件树截图](https://zcode.z.ai/content/docs/v2/screenshots/file-tree-overview-20260611-en.webp)：中心新任务、项目 / 分支、底部输入工具条。
- [文件预览截图](https://zcode.z.ai/content/docs/v2/screenshots/file-preview-20260611-en.webp)：左任务 / 文件、中对话、右内容。
- 已读`packages/ui/src/app-shell/WorkspaceShellLayout.tsx`、`project-sidebar/ProjectSidebarNavigation.tsx`、`v4/ConversationDraftEmptyState.tsx`等，验证独立sidebar / chat / side pane和composer模型控件。

这些证明布局参考，不等于Taomni已安装或运行ZCode，不承诺像素级克隆。官方图和源码只读保存在独立临时目录，未执行下载代码；原型不嵌入官方截图或代码。

## 3. 当前原型与状态

- [打开可交互HTML](ui-prototype-v0.6.html)
- [新任务预览](ui-prototype-v0.6.png)
- [开发会话预览](ui-prototype-conversation-v0.6.png)
- [统一设置预览](ui-prototype-settings-v0.6.png)
- 样式 / 状态 / 交互：[CSS](ui-prototype-v0.6.css)、[纯状态模型](ui-prototype-v0.6-model.js)、[UI脚本](ui-prototype-v0.6.js)。均本地资源，无CDN、模型、凭据或真实文件读写。

支持新任务、已有会话切换、意图选择、引用演示附件、按需变更 / 上下文、计划确认、执行摘要折叠、部分结果 / 一次补救、统一配置保存和取消。页脚场景入口仅供设计评审，不进入产品UI。

原型仅内存状态：设置可被多个演示任务沿用，刷新后还原；正式产品必须持久化。示例worker并列不代表P1A已经接通所有adapter；不支持者应显示未就绪而不是虚构成功。

## 4. 统一配置：两层即可，不把用户逼进一堆profile

### 4.1 执行资源（配置一次）

复用Settings已有LLM providers / Vault / CLI profiles，配置是共享对象：

- API资源：名称、已有连接或endpoint、模型；鉴权复用Vault。
- CLI资源：harness、可执行文件 / profile、模型选择（支持时）；官方登录由CLI管理。
- 高级展开：OpenAI Chat / Responses / Anthropic协议、三代理模式、上下文 / 输出限制、计费单位 / 系数、能力标记。
- 同一资源被多个角色 / 任务使用；不为每次调用重填密钥、URL、协议、成本系数。
- fixture资源只出现在隔离QA配置，不把CI模拟server登记为用户生产默认值。

资源存在不等于已验证可用；原型写“示例配置 / 未检测”，正式连接检查必须用户显式触发并说明是否产生调用。

### 4.2 默认开发方案（跨任务复用）

基础表单：

1. 方案名称（默认“日常开发”）；
2. 规划与设计使用的资源；
3. 可用开发workers；
4. 审阅与复核资源。

高级展开才配置并发、少调用策略、候选顺序 / cost-aware、审批 / 恢复策略、项目覆盖。P1A只需要一个全局默认方案；不先做方案市场或复杂规则编辑器。后续项目可引用同一方案，必要时显式另存共享方案，不让每个task自动产生一份配置。

**简化前台，不合并底层概念**：协议、计费、能力仍是独立typed字段；基础UI不要求逐项填写，不把未知推断成可用或免费。

## 5. 继承、快照与保存语义

概念模型，不要求新增数据库表：

```text
SharedAgentSettings {
  revision,
  resources: [{ id, revision, existing_config_ref, protocol?, model, billing_ref?, capability_ref? }],
  default_plan: { id, revision, name, planning_ref, worker_refs[], review_ref, advanced_policy_ref },
  project_plan_refs: {}  // P1A可为空，项目默认继承
}

TaskSubmission {
  project_ref, branch_or_snapshot, goal,
  intent: develop | plan | review,
  attachment_refs[],
  plan_ref: inherited_default,
  resolved_settings_revision, effective_config_digest
}
```

继承链：应用统一默认 → 显式项目默认（以后）→ 用户主动选择的已有方案（可选）。普通任务不打开配置编辑器，意图不是profile、不会修改全局默认。

- 新任务草稿展示当前默认；发送时冻结resource / plan revision和必要非秘密有效配置，密钥仍是Vault引用。
- 保存统一设置一次，后续多个任务使用新revision；已提交 / 正在运行 / 现有会话继续使用原快照。
- 用户需要让现有任务改用新配置时，显式停止 / 切换并确认新执行；不能热换model / worker / proxy打断上下文。
- 凭据撤销、AI禁用等安全策略仍可立即收紧；“快照不变”不能阻止撤权。
- 设置改动先留草稿；取消、Esc或关闭放弃未保存项。保存校验合法worker / 资源引用 / 系数并CAS；冲突提示重载 / 比较，不last-write-wins。
- 删除正在引用的资源不删历史；新任务blocked / 提醒重选，不能静默fallback。

P1A可把版本化共享设置保存在`orchestration/profiles.json`（文件名兼容原计划，内容升级为共享resources+default_plan）；原始“每run新建endpoint配置”不再是默认路径。历史有效配置摘要 / manifest沿用artifacts，runs / attempts仅存引用，无需第9张表。

## 6. 常见工作流

### 6.1 新开发任务

选择项目，输入目标，可以@引用资料。默认方案已配置则直接发送；不弹协议 / 预算 / 费用填写向导。agent先整理现状与计划，必要的“确认并开始”是一条会话内动作，确认范围 / 后果，不是重新配置资源。

缺默认资源时，只显示“配置一次”引导并保留任务草稿；连接失败提供修复统一资源入口，不弹六七项task参数。

### 6.2 规划 / 长上下文合包

输入框选“规划”或自然语言“先设计，不改代码”。从统一方案选择规划资源和少调用策略，相关设计 / 契约 / 测试规划一次生成。会话里显示简短“正在整理统一方案”，高级执行详情可查看实际call count / 合包成员；不让用户逐次填写NDJSON、window和系数。

严格一次仍遵守main1/aux0/recovery0；配置复用不是“一次配置只准一次调用”，也不是套餐费用按配置次数收费。

### 6.3 协作开发

worker分配在会话的“执行详情”展开，主屏只显示当前动作、实际完成项、需要用户处理的情况。独立工作区、Bootstrap、取消和真实验证继续由后台负责，不能用简短状态省去真实ownership。

### 6.4 变更和资料

点“变更”打开右侧diff；点“上下文”查看规范、正文和来源。关闭右栏、切换任务不取消工作。对没有真实diff的API设计任务，右侧显示文档候选，而不是假代码文件。

原型右侧固定示例会显式标demo；正式实现必须按artifact类型渲染，禁止把设计candidate伪装代码已修改。

### 6.5 部分结果 / 恢复

会话提示“已保存两份，剩余内容未完整”，候选可查看；补全按钮说明额外一次调用，确认才执行，不改变全局恢复默认。无需暴露frame seq，但执行详情保留真实终态 / 未闭合项 / 组门。

## 7. 与v0.4的取舍

| 原方向 | 新方向 |
| --- | --- |
| 创建 / 预算预览 + 运行表格两大页面 | 一套会话主界面，从空态进入同一任务 |
| 每任务协议、模型、调用次数和系数 | Settings配置一次，多任务继承，只读摘要 |
| 任务 / candidate表和gate铺满主屏 | 会话内计划与结果；细节展开 / 右栏 |
| 先教用户使用pack / attempt | 先完成开发目标，pack是底层优化 |
| 主屏强调调度、待后续阶段菜单 | 不显示P1/P2字样；原型脚注明确能力边界 |

保留review修正：八表 / 四目录、先拆codec、分帧保存候选、Bootstrap锁、人工扩权 / 合并、无隐藏补救、模型记忆仅proposed。不能因“像ZCode”默认Full Access或让模型批准权限。

## 8. 设计决策和验收

| DEC | 状态 | 结论 |
| --- | --- | --- |
| DEC-OR11（修订） | **用户已定 / 已查看原型并确认** | 不采用v0.4调度控制台，开发会话主界面，参考ZCode |
| DEC-OR13 | **用户已定** | 简化、统一配置供多个任务复用，不每任务重复配置 |
| DEC-OR14 | **用户确认原型** | 默认只显示方案摘要，点开统一设置；输入框仅项目 / 意图 / 资料，暂不增加逐任务model override |

- AC-UX01：从新任务到发送，不需填写协议 / key / 系数 / call budget；无配置时只引导一次且保留草稿。
- AC-UX02：设置一次后创建多个任务均引用同一方案；intent改变不覆盖全局配置。
- AC-UX03：保存新配置影响后续任务，既有 / 运行任务不追改；取消 / Esc不保存。
- AC-UX04：计划 / worker / 上下文 / diff按需展开，中心对话与输入始终可用；切换视图不取消。
- AC-UX05：设计、开发、审阅保持不同副作用范围；规划不暗改代码，审阅不自动修复。
- AC-UX06：部分candidate不当PASS；恢复额外确认一次，不改变全局默认、不自动合并。
- AC-UX07：简化布局仍有键盘焦点 / 可访问名称、窄窗布局；不以品牌图替代状态反馈。

原型纯状态unit test覆盖共享配置、旧快照不变、取消草稿、意图和恢复上限。设计截图仅静态预览；遵守此前要求，不在本机跑产品browser/native case或GitHub workflow。

## 9. 用户反馈与本轮交付

用户已查看原型并回复“可以的”，要求完成设计更新、详细英文commit、push后等待指令。本稿据此采用当前布局，不再重复询问已确认方向。

本轮仅文档 / 本地原型，不修改产品或workflow、不发模型请求。主界面已从调度表单切回开发会话；统一配置由多个任务共享，普通任务没有必填的profile / 预算向导。

纯状态unit test覆盖共享配置、旧任务快照不追改、取消草稿、意图不改全局、显式一次恢复。首次单测发现空白方案名被接受，已修正trim校验后7/7通过；这是原型模型验证，不是产品功能验证。

原型截图只用于设计视觉检查，不执行本地产品browser/native suite。未来实现仍遵守用户已指定的本地unit、GitHub qa-ui-auto-platforms browser/native、fixture LLM与真实harness验证安排，执行前按下一条指令推进。

若以后需要会话级临时覆盖，须另做明确“仅此会话”交互与权限 / 快照，不默默恢复v0.4长表单。
