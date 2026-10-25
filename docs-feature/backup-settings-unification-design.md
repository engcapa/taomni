# Backup 设置整合与范围继承详细设计

## 1. 范围、决定与状态

- 日期：2026-10-25。调研基线：`65a822785a86c52671983076cd0a244c59626260`；开始调研时工作区干净。本轮仅产出设计、图稿和调研证据，未修改产品代码。
- 实施状态：已在 `feat/backup-settings-unification` 实施，单元测试与 GitHub browser/native 验证结果见文末实现记录。用户已选择同页折叠布局，随后明确限定只改 Backup 部分、支持多语言、保持备份文件格式及旧备份兼容。
- 固定平台：Windows、macOS、Linux 的 Tauri 桌面应用。当前调研环境为 Windows；产品真机验证尚未执行。
- 问题来源：本轮设置截图、用户三项备份设置要求，以及 [GitHub #714](https://github.com/engcapa/taomni/issues/714)。授权问题的独立证据、因果链与修复任务见 [#714 修复设计](../docs-issue/714-feishu-authorization-cancel-design.md)。
- 历史背景：[统一备份设计](unified-backup-design.md)、[原生飞书连接设计](unified-backup/feishu-native-auth-design.md)。仅本设计列出的设置与交互规则取代相关旧规则，其他有效决定继续适用。

本次把现有 Backup 分组内部整理成“全局默认、备份渠道、手工备份、任务与记录、恢复备份”。范围规则为：**手工备份使用全局范围；自动备份使用渠道范围，渠道默认继承全局，可以显式覆盖。** 所有非敏感配置真实落盘，保存中、成功和失败可见。密码仍由系统凭据库或单次操作持有。

### 1.1 硬边界

1. 不改变整个设置页的布局、入口、分组顺序、搜索/定位和展开模型。`SettingsPanel.tsx`、`panel/SettingsPanelView.tsx` 与 `settingsSearch.ts` 的结构保持原样。继续由原有 Backup 位置挂载 `BackupSettingsPanel`，沿用 `settings-group-toggle-backup`。本次不是整个 Settings 的改版。
2. 不改变 `.taobak` 文件后缀、ZIP 布局、归档路径、manifest 字段/版本、加密封装、校验及恢复映射。`MANIFEST_FORMAT_VERSION` 继续为 **1**；继续识别 `TAOBAK_ENC_V1` 和 `TAOBAK_ENC_V2`，新备份使用当前既有写入方式。本次不新增归档版本，不重打包、不批量转换旧文件。
3. 新的继承标记、设置 revision、任务生效范围只属于本机配置或任务 journal，**不写入备份 manifest，不加入归档白名单，也不随恢复替换本机备份控制身份**。
4. 复用现有 `useT()`、`getLocale()` 和中英文字典。所有可见标题、选项、状态、错误、空状态、禁用原因、确认框、ARIA 标签和进度文案均须覆盖中英文。语言切换不重启任务、不重建授权、不重置编辑。
5. 首期可新增的云渠道仍只有飞书。S3、Google Drive、OneDrive、SFTP 不提供假可用入口，不扩展 provider 实现。已有热备、MFA→vault 依赖、加密、代理、续传、后台任务和跨设备恢复契约保留。

### 1.2 决策记录

| ID | 结论、依据及代价 | 状态 | 关联 |
|---|---|---|---|
| DEC-01 | 全局默认 + 渠道继承/覆盖；手工不单独配置范围。手工包括“立即备份”、手工云备份和“导出到”，均取全局；渠道覆盖只影响自动任务 | 用户已定：本轮初始要求 | AC-02～05；TASK-01/02/03；V-01/02/05 |
| DEC-02 | Backup 内部同页折叠：全局置顶，渠道按需展开，手工操作集中，授权提示独立于所选渠道 | 用户已定：异步选择“采用这版布局” | AC-01/09；TASK-03/04；V-03/06 |
| DEC-03 | 设置整体结构保持，只有 Backup 内部变化；V1 示意中的外围侧栏不属于产品变更，V2 已移除 | 用户已定：后续范围约束；V2 为按约束修正，不新增审批 | AC-01；TASK-03；V-03 |
| DEC-04 | 配置统一自动保存，字段就近报错并保留编辑；密码以专门操作保存到凭据库。复用现有设置的即时编辑惯例，不增加页面级“应用”步骤 | agent 自决：现有 `updatePolicy` 已即时持久化，解决静默重置 | AC-02/06/07；TASK-01/03；V-01/04 |
| DEC-05 | 旧云渠道先按原值迁移为显式覆盖，避免升级扩大/缩小范围；新渠道默认继承。旧范围恰好相同也不猜测其用户意图 | agent 自决：兼容既有显式 `source`，一次可恢复为继承 | AC-08；TASK-01；V-02 |
| DEC-06 | 所有新增交互中英完整覆盖；不改 `.taobak` 格式且兼容旧备份 | 用户已定：本轮后续明确约束 | AC-10/12；TASK-03/05；V-03/07/08 |

## 2. 当前实现与缺口

| 代码与符号 | 已核实事实 | 本次处理 |
|---|---|---|
| `BackupSettingsPanel.tsx:34` 的 `scope/includeMail` | 手工范围是 `useState("core")`，没有持久化或从策略初始化；手工创建与导出直接传这组临时值 | 移除独立范围状态，统一全局设置 |
| `RemoteBackupPanel.tsx` 的 `batchScope/batchIncludeMail` | 多目的地入口又维护一组临时本地范围，与手工区、策略、渠道分离 | 删除重复选择器，手工动作共用入口 |
| `BackupTarget.source`、`backup/batch.rs::backup_run_selected` | 云渠道显式保存 scope；批量手工调用中 scope 仅给本地，云端走 target.source | 新手工入口统一取全局；自动任务按继承解析 |
| `BackupPolicy.defaultScope/includeMail`、`policy.rs` | 已有全局策略磁盘文件，但手工 UI 没有复用；只对自动邮件提供即时编辑 | 复用字段作为全局范围的唯一持久化来源 |
| `backupStore.ts::updatePolicy/refreshHistory` | 已有写入队列、编辑版本、迟到读取保护、失败后继续保存；错误会回滚受控值 | 集中配置 owner，改成保留未保存编辑并标错，保留竞态保护 |
| `backup_remote_save_config` | 全量 control 保存被任意运行任务阻止；保存会保留后端拥有的 identity/connection | 新增窄字段 patch；敏感运行参数仍按受影响任务限制 |
| `backup/engine.rs::resolve_scope_flags` | full = core + 聊天 + 邮件；邮件可被 `customOptions.includeMail` 覆盖；full 目前不包含 local history | 不借改版改变范围含义；摘要必须真实展示邮件例外 |
| `backup/manifest.rs`、`crypto.rs`、`restore.rs` | manifest v1，V1/V2 加密读取和现有恢复路径已经存在 | 保持编解码契约，以旧文件和当前写入结果回归 |
| `SettingsPanelView.tsx`、`BackupSettingsView.tsx` | 外层原有设置分组挂载；Backup 内部把远端整块、目录、手工、自动、恢复、历史纵向重复堆叠 | 仅替换 Backup 内部编排 |

“Full Data 不保存”的临时状态原因由源码确认；本轮未在用户真实配置上操作。既有三份相关前端测试共 **28 passed**，没有覆盖该缺陷的重开/重启断言，不能将它们通过视为缺陷已修复。环境、命令与范围见 [调研记录](backup-settings-unification/research-evidence.md)。

## 3. 当前有效图稿与交互

用户已选择 V1 的 Backup 内部布局。**当前有效稿为 V2**：根据后续约束裁掉外围侧栏，只展示原有 Backup 分组；增加英文总览供长文案评估。外围 Settings 不属于图稿改动范围。

| 图稿 | 预览 | 可编辑源 | 尺寸与状态 |
|---|---|---|---|
| Backup 总览，中文 | [PNG](backup-settings-unification/overview-v2.png) | [draw.io](backup-settings-unification/overview-v2.drawio) | 内容区 950×1040；全局 full、一个渠道继承、另一个覆盖 |
| Backup 总览，英文 | [PNG](backup-settings-unification/overview-en-v2.png) | [draw.io](backup-settings-unification/overview-en-v2.drawio) | 相同布局；英文长文案 |
| 渠道同页展开 | [PNG](backup-settings-unification/channel-expanded-v2.png) | [draw.io](backup-settings-unification/channel-expanded-v2.drawio) | 内容区 950×1080；未启用/未连接渠道 |
| 授权恢复状态 | [PNG](backup-settings-unification/authorization-recovery-v2.png) | [draw.io](backup-settings-unification/authorization-recovery-v2.drawio) | 内容区 950×1040；等待、取消、移除 |

图稿为设计示意，不是产品截图，也不证明 UI 或原生测试通过。预览已实际渲染检查；最终产品继续使用现有主题 token、字体和设置容器。图稿顶部折叠标题代表已有 SettingsGroup，Backup 内部不再新增同名总折叠层。小于 760px 的 Backup 内容宽度时，列式渠道行和双列字段改为纵向排列；950px 只是图稿宽度，不新增设置窗口最小宽度。

### 3.1 分区及字段归属

| 分区 | 默认显示 | 展开或操作时显示 | 配置归属 |
|---|---|---|---|
| 全局默认 | 核心/完整、包含邮件、生效摘要、自动计划开关与 daily/weekly/on_exit | “更多范围选项”仅承接已有 custom 值及既有八类可备份项，不新增归档类型 | policy 的全局范围/计划 |
| 备份渠道 | 名称、启用状态、自动范围来源与摘要、连接状态、展开按钮 | 本地：目录、保留份数、范围继承；飞书：名称、范围继承、账号/应用、目录、代理、密码状态 | 本地 policy；云端 target |
| 手工备份 | 只读“使用全局范围”、持久化的目的地选择、“立即备份”“导出到…” | 导出保留原生文件选择；可选单次本地加密密码放操作对话框，不成为第二套范围设置 | 范围读取全局；目的地 control；单次密码不持久化 |
| 任务与记录 | 活动数量、最近成功、需处理错误摘要；错误不能因折叠完全消失 | Backup 内部的后台任务、本地快照、云端备份视图；缓存用量/清理放后台任务中 | 后台 journal/历史/只读远端查询 |
| 恢复备份 | 原有选文件恢复入口、云备份列表入口 | 复用现有检查/密码/来源/文件清单/覆盖确认/重启流程 | 保持现有恢复 owner |
| 活动授权提示 | 存在活动授权即在 Backup 内容顶部显示，独立于目标选择及渠道折叠 | 取消、重新打开网页、定位渠道、移除本地任务 | 后端授权 owner；详见 #714 |

设备名与只读设备 UUID 收入渠道区的“更多备份设置”折叠项，继续允许改显示名、复制 ID；不放在每个飞书目标表单中重复编辑。缓存容量与保留期/清理放“任务与记录 → 后台任务”，云端设备筛选放云端备份列表。图稿默认收起这些低频项，不表示删除能力。图稿底部的版本/范围说明是交付注释，不进入产品 UI。

“启用渠道”沿用云 target.enabled 的含义：影响云写入资格及自动调度，不把它误标成仅自动备份开关。全局自动开关只控制自动触发，关闭后已启用云渠道仍可手工备份。新增本地渠道开关仅控制它参与自动/批量目的地执行，独立导出文件仍可用。禁用渠道不删除备份或取消已启动任务；任务取消需显式操作。

添加飞书渠道先建立已持久化、未启用的 target，再展开配置；未完成目录/密码/授权就显示未就绪原因，不能展示“已连接”。添加期间取消可移除该未启用目标，但不能隐藏其他目标的活动授权。多个渠道可展开，焦点不因后台刷新而跳动。

### 3.2 范围的唯一解析规则

```text
手工立即备份 / 手工云备份 / 导出文件 = globalRange
自动本地 = localRangeOverride ?? globalRange
自动云端 = target.rangeMode == inherit ? globalRange : target.source 的范围
重试 / 续传 = 原任务已记录的范围或现有 artifact，不重新取当前设置
```

例如全局 full（含邮件），本地继承，飞书单独 core：手工同时备份到本地与飞书时两者均 full；自动执行时本地 full、飞书 core。UI 的列名明确为“自动备份范围”，避免把覆盖误解成手工范围。

- 新建渠道 `inherit`。选择“单独设置”时，以当时的全局值初始化独立副本，并作为一个 patch 保存；修改副本不会回写全局或其他渠道。
- 选择“继承全局”后立即按全局派生摘要；保留最后的独立副本供再次切换，但运行时不读取它。切换的 mode 与副本在同一个配置文件原子保存。
- 全局 core/full 切换时，把预设与邮件默认一起提交：core→`includeMail=false`，full→`includeMail=true`，不携带上一预设的临时 false。之后用户可以明确取消邮件，摘要相应为“完整数据（不含邮件）”。
- core/full 的其他数据项沿用现有解析，full 不被重新定义为包含 local history；custom 八类选项及 MFA 强制包含 vault 仍按已有能力解释。不能为支持继承创建新的 scope 枚举值或 manifest 字段。

### 3.3 保存、失败与关闭

| 状态/动作 | 可观察结果 |
|---|---|
| 进入 Backup | 先读盘再启用配置控件；加载失败提供重试，不能显示默认 core 假装加载成功 |
| 单选/下拉/开关修改 | 立即展示 draft 并排队保存；涉及同一预设的字段一个 patch；显示“保存中…” |
| 文本/数字输入 | 失焦或 Enter 提交，短防抖只合并同字段；合法性错误就近显示，不用空值覆盖磁盘 |
| 保存成功 | 以实际持久化返回快照作为 committed；无其他 dirty/pending 时才显示“所有更改已保存” |
| 保存失败/冲突 | 保留 draft，字段/分区报错并给重试；显示未保存状态。修复原因后可继续保存，不让失败毒化后续队列 |
| 快速编辑或迟到刷新 | 序列化写入、按 editVersion/revision 丢弃旧读取；最后一次用户选择保持可见；服务端时间戳不会被旧表单覆盖 |
| 收起 Backup/切换设置组 | store 继续已排队保存。没有待保存值时可直接离开；密码草稿按操作生命周期清空；重开从 committed/draft 与磁盘恢复 |
| 退出进程 | 优先完成已排队的本机配置写入；失败提示未保存并允许返回处理。进程被强制杀死只保证已确认保存的数据，不声称临时文本也已落盘 |
| 点击立即备份/导出/连接 | 先 flush 相关非敏感设置保存；存在失败或 revision 冲突则阻止创建任务并指向未保存字段；不偷偷用旧 core 执行 |

提交队列属于 store/后端，不能由渠道编辑组件卸载时销毁。未失焦的无效文本不是已保存配置，重启不恢复它；密码不进 localStorage、持久化 Zustand 或日志。“已保存”专指磁盘/凭据写入成功，而不是 React 值已改变。

## 4. 数据与接口契约

### 4.1 本机持久化及兼容

继续使用 `backup_policy.json` 与 `backup-control/config.json`，不新建一份重复的全局范围数据。两个文件各自原子写入；一次 patch 只修改一个域，不实施跨文件伪事务。

| 位置 | 字段与缺省 | 规则 |
|---|---|---|
| policy，已有 | `defaultScope`、`includeMail`、`autoBackupEnabled`、`frequency`、目录/保留份数/`lastBackupAt` | scope + includeMail 是全局预设的权威值；lastBackupAt 后端拥有 |
| policy，拟新增 | `settingsRevision: number = 0`；`defaultCustomOptions: BackupCustomOptions \| null = null` | revision 仅随可编辑设置提交递增；custom 项仅 scope=custom 使用 |
| policy，拟新增 | `localChannelEnabled: boolean = true`；`localRangeOverride: BackupRange \| null = null` | null 是继承；旧本地自动范围原本即 policy，因此默认继承无变化 |
| target，已有 | `source`、`enabled`、`proxy`、目录与 connection 引用 | source 继续是旧 `SourceSpec`；不把 inherit 当作 scope 传归档引擎 |
| target，拟新增 | `rangeMode: "inherit" \| "custom"` | 旧 JSON 缺少此字段按 custom；新渠道工厂显式 inherit |
| control，拟新增 | `settingsRevision: number = 0` | 继续 formatVersion=1；后端 connection/身份更新也维护 revision，前端不能覆盖它们 |
| 任务 journal，拟新增 | 可选 `executionRange`、`trigger`、设置 revisions | 记录新任务实际范围；旧任务字段缺省可读。与 `.taobak` 格式无关 |

`BackupRange = { scope: BackupScope; customOptions: BackupCustomOptions | null }`。全局 core/full 从 policy 字段派生；不再同时持久化另一个 globalRange 对象。读取旧 includeMail=null 时沿用旧预设默认；显式 false 不得丢失。

全新 profile 沿用既有默认：core、不含邮件、自动计划启用且 weekly、本地保留 7 份、系统默认目录、手工目的地仅 local。本地渠道默认启用且继承；新飞书目标默认未启用、继承范围、代理 app。安装升级一律读取旧配置，不用这组默认覆盖已有 full/daily/90 等选择。

旧云渠道保留原 source，迁移为 custom，即使与全局恰好相等也不自动切换。列表可标“沿用原配置”，给“恢复继承全局”操作。旧文件只在成功提交/迁移时原子写回，坏配置明确报错；不能静默变 core。升级不改设备 UUID、账号绑定、目标密码、代理、目录、selectedTargetIds、计划或时间戳。新增字段默认规则经过版本往返测试后才能发布；代码回退使用升级前的本机配置副本，不能靠旧程序写回来保证保留继承语义。

### 4.2 拟新增入口与既有兼容入口

| 名称 | 输入/输出 | 权责与错误 |
|---|---|---|
| `backup_settings_get`（新） | 无 → `{ policy, remote: RemoteConfiguration, revisions: {policy,control} }` | 聚合读取而非复制配置；失败保留上次快照并报告来源 |
| `backup_settings_patch`（新） | `{ request: { domain, expectedRevision, patch } }` → 该域已保存的快照与 revision | domain=`policy` 时仅允许可编辑策略字段；domain=`control` 的 patch 为下述受限操作；冲突返回 `BACKUP_CONFIG_CONFLICT`，不写旧全量对象 |
| control patch（新） | `op: updateTarget/addTarget/removeTarget/setDeviceName/setSelectedTargets`，以及对应 targetId/可编辑字段/name/ids | connectionId、connections、device.id 和 writesPaused 不接收前端任意修改；移除不得删除远端文件 |
| `backup_target_set_password`（新） | `{targetId,password}` → 刷新后的密码配置状态 | 独立 keyring 写入，空字符串不代表清除；失败不启用目标、不显示成功；不在配置返回明文 |
| `backup_run_manual`（新） | `{request:{destination: {kind:"selected",localPassword?} 或 {kind:"file",path,password?}, expectedPolicyRevision, expectedControlRevision?}}` → 原有逐目的地结果结构 | 后端取已保存全局范围；selected 时读取持久化目的地并核对两域 revision，file 时仅需 policy revision；失败不创建误范围任务；可选单次密码只给本地副本，云端继续用各目标独立密码 |
| 现有 `backup_create`、`backup_run_selected`、`backup_remote_start` | 保留 IPC 名称、参数及旧调用者兼容行为 | 新 Backup UI 的所有手工创建统一走新入口；旧低层接口不作为新界面的独立范围入口，测试和兼容调用仍可用 |
| 既有 inspect/stage_restore、job 与 authorization 事件 | 沿用 payload 与 revision 排序；#714 增加的取消/移除确认见修复设计 | UI 卸载只解绑监听，不取消任务；不能在布局提取时改变恢复语义 |

新入口在 `commands/backup.rs` 的现有宏注册，前端包装放 `src/lib/backupSettings.ts`（新）；camelCase DTO 与 Rust serde 保持对应。不直接让组件调用文件或控制凭据。

### 4.3 状态所有权与运行快照

- `backupSettingsStore.ts`（新）统一拥有已保存 snapshot、draft、dirty 字段、分域队列、revision、错误和 flush。`backupStore` 的既有 policy/updatePolicy API 作为委托保持兼容，不能继续拥有第二套写入队列。依赖方向 `backupStore → backupSettingsStore → lib`，禁止反向导入。
- `backupControlStore.ts`（新）拥有 jobs、所有授权会话、远端列表的 generation、事件订阅/轮询。编辑中的 target 只存字段 draft，不能由远端整块刷新替换。按 job/session revision 拒绝旧消息；跨设备筛选按 target+device 隔离。
- 手工/自动创建时由 Rust 解析并记录确定的范围，worker 收到具体 SourceSpec，不能在稍后读 target.source 把新任务变成旧范围。正在生成、排队、失败重试和续传均使用该任务的原值；已有 artifact 优先直接续传。
- 旧 journal 已有 artifact 时不重打包。旧 journal 没有 executionRange 且需重新快照时，按旧 target.source 规则处理并标记 legacy；不能套用新继承解释悄悄改变已排队任务。
- 保存策略继续复用 `BackupCoordinator`/`BackupProcessLock`；control 复用进程与文件锁及原子替换。新的联合执行准备先解析数据库路径，按 **jobs gate → coordinator.operation → profile process lock → control lock/file lock** 获取必要锁；释放后再做异步网络。不能在持 gate 时递归调用会重新加 gate 的旧 `jobs::start`，需提供接受冻结执行计划的内部入口。纯字段 patch 不获取无关域的锁；取消授权不等待长时间快照锁。
- 不改变 lastBackupAt 既有更新时间和本地历史轮换规则：写进当前备份目录的文件仍按 maxRetainedCopies 处理；云任务不覆盖本地时间戳。后台字段更新必须保留新加入的设置字段与 revision。
- 运行中的同目标代理、密码、账号、目录或移除操作明确返回 busy；不再用“有任意任务”全局阻止范围、选择项和不相关目标的编辑。取消、查看状态始终可达。已有 artifact 的网络/凭据相关变更限制沿用安全约束。

### 4.4 网络与密码保持的行为

每个云渠道继续支持 app/custom/none，默认 app，独立代理不覆盖应用设置；custom 复用 `AppProxyPanel`，接入本次统一 dirty/保存反馈。none 使用共享解析明确绕过环境/系统代理，代理失败不自动直连。连接、注册、刷新、上传、下载均使用该渠道代理。

云端仍强制独立加密密码，修改只影响后续归档，旧归档使用旧密码。系统凭据不可用时阻止启用，不能退化为明文 JSON。本地即时备份和独立导出均保留单次密码能力：“立即备份”的更多操作可选择“加密本地副本…”，在小对话框只输入本次密码，不提供范围选择；独立导出同样可加密。不将密码持久化成设置文本；自动本地备份保持既有加密策略。下载仍显示连接/下载/校验/完成/取消/失败、字节及可用总量，未知总量用不确定进度，提供取消/重试/续传。关闭视图继续任务，重开恢复进度；缓存清理保留未完成部分，完整校验前不替换可用备份。

## 5. 多语言与无障碍契约

在 `backupSettings` 和 `remoteBackup` 现有命名空间内补齐中英 key；下表为拟新增 key，最终与实际布局一一对应。不得把后端原始英文错误直接当作中文主提示。

| key（省略 backupSettings 前缀） | zh-CN | en |
|---|---|---|
| `defaultsTitle` | 全局默认 | Global defaults |
| `channelsTitle` | 备份渠道 | Destinations |
| `inheritRange` | 继承全局 | Inherit global defaults |
| `overrideRange` | 单独设置 | Customize for this destination |
| `scheduledRange` | 自动备份范围 | Scheduled backup scope |
| `manualRangeSummary` | 使用全局范围：{scope} | Global scope: {scope} |
| `saving` / `saved` | 保存中… / 所有更改已保存 | Saving… / All changes saved |
| `saveFailed` | 未保存：{reason} | Not saved: {reason} |
| `configConflict` | 设置已被其他窗口修改，请重新加载后重试 | Settings changed in another window. Reload and retry. |
| `rangeWithoutMail` | {scope}（不含邮件） | {scope} (excluding mail) |

授权取消、取消中、已取消、移除任务、停止并移除、外部应用不删除等 key 由 #714 文档定义。状态 store 保存 key/错误码/参数而非翻译后的字符串，切换语言立即重绘已有错误、成功提示、进度与授权状态。用户输入的设备名、渠道名和路径不翻译。日期使用当前 locale，字节/百分比使用 locale-aware 格式化；没有总量时不显示 0%。保留脱敏技术详情折叠区。

折叠控件具备 `aria-expanded`、区域关联与键盘操作；单选与代理选项可用键盘切换；错误通过 live region 通知而不抢焦点。移除确认 Esc 取消并恢复原焦点；折叠状态不影响后台任务。英文长文案应自然换行，宽度 600/950px、深浅主题及 200% 文本缩放均可访问，不能靠隐藏操作按钮避免溢出。

## 6. 验收条件与追踪

| AC | 场景、动作与结果 | TASK | V |
|---|---|---|---|
| AC-01 | 从原设置入口打开/搜索定位 Backup，外层布局、其他分组和入口保持；仅该分组按 V2 重组，窄宽度无横向遮挡 | 03/05 | 03/06 |
| AC-02 | 全局选 full 并等到已保存，收起/重开及重启后仍 full；手工区无独立范围选择，执行出的文件列表符合 full | 01/02/03 | 01/05 |
| AC-03 | 新渠道默认继承；全局改变后继承渠道摘要及后续自动归档随之改变；本地和云端一致 | 01/02 | 02/05 |
| AC-04 | 渠道覆盖 core 不影响其他渠道或全局；切回继承恢复联动；同渠道手工任务仍用全局 full | 01/02/03 | 02/05 |
| AC-05 | 切 full 后邮件默认选中；明确取消则保存 false、摘要说明、生成归档不含邮件；MFA→vault 与既有 full 范围含义不变 | 01/02/05 | 01/02/07 |
| AC-06 | 快速连续改范围/频率，无旧响应覆盖；磁盘失败保留 draft 且报未保存，可重试；提交失败不能用旧设置开始备份 | 01/03 | 01/04/05 |
| AC-07 | 目录、份数、启用、名字、设备名、目的地、代理模式/独立代理和密码状态正确恢复；机密不进入普通配置/日志 | 01/03/05 | 04/05 |
| AC-08 | 旧 policy/target/journal 升级后原范围、显式邮件 false、目录、代理、身份、密码和未完成任务保留；坏配置不重置 | 01/02 | 02/07 |
| AC-09 | 活动授权不依赖当前目标；任意切换后可取消/移除，确认停止后能重新连接，迟到结果不复活任务 | 04 | #714 V-01～05 |
| AC-10 | zh-CN↔en 切换时全部新增状态/反馈即时翻译，任务与 draft 不重置；英文及窄宽布局可操作 | 03/04/05 | 03/06 |
| AC-11 | 后台继续、重开恢复进度，未知总长、失败/取消/续传、缓存清理与本地/云端历史操作保持真实结果 | 02/03/05 | 05/06 |
| AC-12 | 旧明文/V1/V2 加密 `.taobak` 均走现有检查与暂存恢复；新备份沿用原格式、manifest v1 和目录映射，无继承字段进入归档 | 02/05 | 07/08 |
| AC-13 | 设备 UUID 恢复后保持本机身份；原有云端当前下载、网页历史恢复后重下、写入暂停/恢复继续可用 | 04/05 | 05/08 |

## 7. 可交接工作包

任务编号仅属于本设计，不创建看板任务，不表示已经启动执行者。每个任务同时负责目标断言及被影响的保留行为；共享文件在集成任务中统一协调。

| TASK | 目标、职责和文件 | 依赖与完成条件 |
|---|---|---|
| TASK-01 配置与保存 owner | 新 `src/lib/backupSettings.ts`、`stores/backupSettingsStore.ts`、Rust `backup/settings.rs`、`settings_model.rs`；调整 policy/model/control 的新增字段与原子 patch，backupStore 旧 API 委托，stub 补相同语义。Rust 对旧文件迁移、坏配置、revision/失败恢复有真实磁盘断言 | 可开始；按第 4 节契约，V-01/02/04 通过，保证唯一状态 owner |
| TASK-02 执行范围解析 | 新 `backup/range.rs`、`execution_plan.rs`；调整 batch/jobs/worker/scheduler，提取 engine 中受影响的策略解析，打包/加密/manifest/restore 编解码保持不变 | 依赖 01 的数据契约；V-02/05/07；手工、自动、重试所有路径都有冻结范围 |
| TASK-03 Backup 内部 UI | `BackupSettingsPanel.tsx`、`backup/BackupSettingsView.tsx` 保持入口/组合壳；新 `BackupDefaultsSection.tsx`、`BackupChannelsSection.tsx`、`BackupChannelEditor.tsx`、`BackupManualSection.tsx`、`BackupActivitySection.tsx`、`BackupRestoreDialog.tsx`；两套 locale 同步；原生文件选择复用原入口 | 依赖 01，图稿已定；V-03/04/06；Settings 外层结构零变更，无重复范围/事件 owner |
| TASK-04 授权与远端状态 | 按 [#714 工作包](../docs-issue/714-feishu-authorization-cancel-design.md#6-工作包) 实施；新 `stores/backupControlStore.ts`；`RemoteBackupPanel` 降为共享 owner 的兼容组合，不再持有一套独立全量配置与只对当前目标可见的活动会话 | 可先做 #714 复现与状态回归；接入 03；#714 V-01～05，并保留已授权应用/其他渠道 |
| TASK-05 集成与兼容验收 | 负责 01～04 的交汇、现有 testid/case 调整、F-BACKUP-2 目录维护、固定旧归档样本、当前端原生步骤与证据；统一协调 lib/remoteBackup.ts、backup/mod.rs、commands/backup.rs、两套 locale | 最终集成；运行第 8 节去重验证集，回填结果，负责本次引入的相邻退化 |

前端新组件/owner 目标 200～500 行，不能超过 800。当前 `BackupSettingsView.tsx` 716 行、`engine.rs` 782 行，禁止直接继续膨胀；恢复对话框、任务列表、配置 owner 和执行规划按职责抽取，连同 state/effect、取消、订阅释放和 stale guards 一起迁移。不得用压缩格式、删除断言或 generated 字符串绕过检查。归档文件结构与编解码实现不是本次重构目标。

## 8. 验证计划与当前证据

设计阶段仅执行既有快速基线，不声称下述新验收通过。产品实现后遵循迭代→稳定后一次当前端构建/真机→最终集成，避免逐组件全量构建。

| V | 层级/文件与断言 | 执行与证据状态 |
|---|---|---|
| V-01 | 新 `backupSettingsStore.test.ts` + 现有 backupStore 测试：full 保存后重挂载、rapid full→core→full、迟到读取、失败保留草稿/可重试、flush 阻止误执行、full 邮件默认与显式 false | 新测试待实现/执行；既有 store/组件 28 项基线通过 |
| V-02 | 新 Rust `backup/range_tests.rs`、`settings_tests.rs`：临时目录实际写入后销毁/重建 service；legacy 缺字段、mail=false、坏 JSON、migration 幂等；manual/scheduled/retry 范围及局部 patch 不覆盖后端字段 | `cargo test --manifest-path src-tauri/Cargo.toml --lib backup::`，实现后执行；不以 mock IPC 证明落盘 |
| V-03 | 新分区组件测试与 BackupSettingsPanel 组合回归：原入口、无重复范围、继承/覆盖摘要、键盘折叠、保存失败/忙碌原因、语言往返后状态保留 | `pnpm exec vitest run src/components/settings/BackupSettingsPanel.test.tsx src/components/settings/RemoteBackupPanel.test.tsx src/components/settings/backup`；新目录测试待实现 |
| V-04 | save/store/Rust 边界：无写权限、代理无效、revision 冲突、不同字段连续保存；普通配置不能出现测试密码；新 password API keyring 拒绝时不能假启用 | 配置内存断言不足，Rust 临时目录及隔离凭据区分别验证；待执行 |
| V-05 | 当前 Windows 原生合并场景：设置 full→已保存→关闭重开→退出重启；本地继承/飞书覆盖；生成手工/自动归档检查真实 manifest 文件列表；已有任务在设置改变后仍续传原 artifact；三代理及失败/取消恢复 | 按第 9 节，待执行；需要真实 Tauri/磁盘/受控 provider，浏览器 stub 不证明此项 |
| V-06 | 浏览器/当前 WebView 验证 Backup 分组 V2：600/950px、深浅主题、中英、200% 文本；F-BACKUP-2 现有 `TC-BACKUP-CLOUD-001/002/005` 调整原控件映射并保持结果断言；增加拟定 `TC-BACKUP-SETTINGS-001`（需落卡前查重） | 不在本设计编写 YAML 或伪称已登记。TASK-05 维护 case，浏览器后集中当前 WebView smoke；待执行 |
| V-07 | 旧归档兼容：固定历史明文、`TAOBAK_ENC_V1`、`TAOBAK_ENC_V2` 样本，含无 provenance 的 manifest v1；沿用现有读取/校验/密码错误断言；新 writer 仍 manifest v1、旧路径、既有加密封装且无新配置字段 | golden 样本应在改写入路径之前固定，不用候选 writer 临时生成全部“旧样本”。新测试 `backup/archive_compat_tests.rs`；待执行 |
| V-08 | 原生恢复：隔离数据恢复旧备份并重启，验证真实 DB/MFA/邮件，设备身份不替换；新备份交给当前基线读取链路独立检查，不从新 reader 自测推导旧版本兼容 | 当前端真实 UI 与旧基线 reader/受控测试夹具；不得用旧程序打开用户正在使用的 profile；待执行 |

快速测试从工程根目录执行，不在 Vitest 文件过滤器前加 `--`。实现稳定后执行 `pnpm check:refactor`、`pnpm build`，Rust `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 及所选 backend 测试。交付测试采用仓库要求的 Node 22/pnpm 10；本次调研机器实际 Node 24.21.0/pnpm 12.4.1，只作为既有快速基线，不替代要求工具链的集成结果。

## 9. 三端真机手册与交付

实现后先使用仓库 QA 隔离 profile 或专用测试 app-data；不得移动、覆盖或恢复开发者真实数据库。被测应用绑定候选前后端，记录构建身份/平台/WebView、命令、时间、截图、配置脱敏摘要与归档 hash。当前 Windows 收尾只需一个稳定构建覆盖下列合并路径：

1. 原设置入口打开 Backup，其他设置组、搜索定位保持。中英切换后配置/dirty/error 不丢失。
2. 全局选 full 等待“已保存”，本地继承，飞书改 core；修改目录、保留份数、目的地和三代理之一，重开/重启复核两份真实配置。无配置读取错误被 core 默认掩盖。
3. 使用隔离会话/笔记/MFA/聊天/邮件样本，手工选本地与可用云渠道。实际归档均 full；触发已配置自动计划时分别得到 full/core。用现有 inspect 解密并检查文件列表，不能只查下拉框或 journal。
4. 注入磁盘失败，编辑保持且不报成功，立即备份被阻止；恢复权限后重试保存与创建。验证云连接取消/切换渠道流程见 #714 真机步骤。
5. 在受控网络/provider 上启动下载，关闭重开恢复进度，取消真正停止网络，重启恢复安全 partial；校验失败不覆盖有效文件。当前版本/网页历史回退、写入暂停、缓存清理和本地历史恢复按现有结果回归。
6. 独立隔离 profile 中恢复历史三类归档，走密码/覆盖确认/重启路径；验证实际数据与本机 UUID。新备份由基线 reader 检查成功；文件格式和输入文件 hash 不因设置升级变化。

| 平台 | 受影响原生边界 | 本轮状态与接续 |
|---|---|---|
| Windows | WebView2、文件选择/原子替换、Credential Manager、真实 Tauri IPC/后台授权 | 当前运行端；本次为设计，以上产品真机步骤均待执行 |
| macOS | WKWebView、Keychain 权限、目录/文件替换、退出前保存 | 保留同样主流程与拒绝后重试；未验证，由对应设备接续 |
| Linux | WebKitGTK、Secret Service、目录权限、退出前保存 | 保留同样主流程；无 Secret Service 明确报错不明文降级；未验证 |

代码必须三端兼容，不引入平台专属 UI/API；平台存储复用现有适配。以上“待执行”是设计阶段的验证计划；实施后的实际通过、失败及未验证范围统一记在下方实现记录，不从计划推导三端已实测。

实现与验证记录：[`backup-settings-unification/implementation-status.md`](../docs-feature/backup-settings-unification/implementation-status.md)。
