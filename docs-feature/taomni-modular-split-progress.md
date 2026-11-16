# 模块化实施与验收台账

更新：2026-11-16。范围以[设计 §10.1](taomni-modular-split-design.md#101-可执行任务分解)与 [ADR](../claudedocs/adr-taomni-modular-split.md)为准。基础契约通过不代表业务已迁出或可发布。

## 当前结论

核心仍包含 MFA、Servers、SocksCap、远程桌面和本地语音等业务代码、状态与依赖。hello-plugin 已有签名安装验证；MFA engine 与真实 SDK 宿主原型的两处 RPC 修复已由匹配源码的三端真实宿主门及 Linux 真实 Vault 门复验。MFA 四目标签名包已产出，源码 `2a14e5590` 的 Linux、Windows 正式安装门均已通过 3 项实际场景；macOS framework staging 修复正在新 runner 复验；产品 facade 尚未切换。主窗/分离窗动态前端已实现，空列表修复后的 browser 已进入刷新步骤；刷新可见模式和 macOS 跨 scheme ESM 失败已分别修复，须复验 TC-MODULES-016/017/018。LanChat 已删除；历史 `lanchat.sqlite` / `lanchat.db` 保留原位，不读取、不迁移、不删除。

生产升级 IPC 当前只记录只读预检、源指纹与 pending journal。缺少可信插件包和真实 exporter 时，不复制旧数据、不创建伪插件版本、不改变 active 指针。测试 fixture 的 staging/回滚原语不能算真实旧版升级验收。

签名安装门、宿主生产监督、共享采集/RDP 公共库、CoreState/统一 bootstrap、正常退出与可逆静默已集成。生产工厂、scoped 入口、持久 profile generation、Vault IPC 协调、普通凭据消费者与 MFA facade 已接入；源码 `fdd05d232` 的契约 #43819768258 已 23/23 jobs 成功，其 UI #43819770975 的 22 个 shard 已收齐：三端 browser 各 50/50、Linux Xvfb native 50/50、Windows native 48/48、macOS native 47/47；Wayland 46/50，四个既有无关失败按下文单列。离线 v2 备份/还原和运行中宿主快照已实现，`4c060a939` 的三端真实宿主快照及整轮契约通过，匹配源码 UI 仍在执行。业务状态仍在 LegacyFeatureRuntime；三态真实重启还原、远端商店、重启下载恢复、业务宿主迁出与真实升级尚未完成。G1–G11 未通过前，不将具体业务插件迁移标为完成。

## 2026-11-16 最新 runner 证据（持续采集中）

- 同源 ESM 与刷新 focus 修复源码 `9e66e878b93cf8ea7d0019b9c0ad0362d7176a34` 已推送，[UI #43889971881](https://github.com/engcapa/taomni/actions/runs/43889971881) 执行全部 71 个明确受影响用例与完整 browser/native crash-regression、Linux Xvfb/Wayland、三端 release QA；已启动即时 shard 采集器。单独 dispatch `qa-modular-download.yml` 返回 404（默认分支没有注册该 workflow），没有新下载门执行；已有升级 workflow 新增 `download_only`，只选三端真实下载/重启门，并与完整升级 run 使用不同并发组，避免中断正在执行的 MFA 安装验证。actionlint 和 check:refactor 已通过；仍须推送该 workflow 后从已注册入口重新触发。
- 下载恢复提交 `13db526db509529304e222c6517e9a9e07a435f5` 的[契约 #43888300225](https://github.com/engcapa/taomni/actions/runs/43888300225) 正在执行并即时取回结果。Linux/macOS 实际日志各确认原网络 3+9+1 项及新增 restart 2 项通过；Windows 网络 3+9 项、完整 prefix 无请求发布通过，kill 场景在断连观察收到真实 `WSAECONNRESET/10054`，原测试只接受 Unix EOF 导致失败，尚未执行后续恢复部分。修复断言仅在 Windows 接受 ConnectionReset，保留五秒关闭期限、其它错误/字节拒绝及完整重开/Range/hash/再重开断言，须新源码 hosted 复验。当前不能记三端 restart 全通过。
- browser #43886610157 的 Linux 完成 shard 已下载：空状态、首次保存、inactive draft、重复 Open 均已越过，TC-MODULES-017 在刷新后等可见列表失败。截图为 Home，HTML 的模块仍挂载且 `data-active=false`；生产 locator 恢复只写 activeTabId，未切换可见模式。两项单元先复现后通过：用普通 setActiveTab 恢复 Sessions；用户主动切 Home 时只保存 locator，避免刷新后抢回模块。原用例不放宽可见性等待或保存值断言，仍须新源码复验。macOS 打包 ESM 新增应用同源保留路径，所有主窗/分离窗共用原 registry/逐文件 hash 验证，CSP/CORS 不放宽；路径/origin/穿越/相对 chunk 六项 Rust、前端五文件 41 项单元通过，真实 ESM 等 runner 结果。
- #43875317089 的最后 macOS shard 3 已于运行中取回，11/11，包含三态的卸载保留还原、真实重启与既有 signed module 生命周期。该 run 共 22/22 shards 收齐；macOS native 为 46/48，只有 TC-MODULES-016/018 的 ESM 导入失败；不再存在未收取的 macOS shard。较早 #43864283226 的 macOS shard 1/2/4 为 cancelled，只有 shard 3 的 12/12，不将取消项计通过。
- 下载恢复批次已接入生产 bootstrap：`.downloads/.jobs` 原子保存无代理凭据的任务描述，启动后只发现任务、不自动联网；恢复时读取实际 partial 长度并重新校验 completed 的大小/hash。新增 list/resume IPC，显式恢复重新解析当前代理；跨实例的 id/path/URL/hash OS 锁保持到网络与文件工作全部停止，进程崩溃后由系统释放。忘记任务保留安全 partial；损坏记录单列错误且不丢弃其它任务。28 项下载单元通过、3 个原真实网络单元保持 ignored；真实核心 harness 和新增进程门只编译通过，未本地执行。新增两项 hosted 场景验证真实 kill/连接关闭/重开恢复/Range 与最后一段已落盘后的无网络发布，沿用三端 download workflow。尚缺远端商店入口、共享完整代理解析和独立持久代理 UI、renderer 后台任务投影、跨重启 UI 用例，不能据此标 TASK-007/010 或 AC-003 完成。
- `386473fc2a45050ff3f51723be855cd9f90c5692` 的 [browser #43886610157](https://github.com/engcapa/taomni/actions/runs/43886610157) 正在执行 TC-MODULES-017 与完整 crash-regression，即时 shard 采集器已启动。此前 #43885872571 的 plan 使用短 SHA，checkout 当成 ref 查找失败，没有执行任何 case；本次改用完整 SHA。空列表修复已由实际独立 ESM 单元复现并通过，不将尚未执行完的 UI 计为通过。
- #43875317089 已收取 21/22 个 shard（另加 selection）。三端 browser 各 42/43；Linux Xvfb 49/51、Windows 47/49，失败均在 hello 空列表的可见性断言，已由 `386473fc2` 修复但须新源码复验。Wayland 47/51，另两项既有 FILE-OPEN-006/008 单列。macOS 已收取的三个 shard 为 10/11、11/11、14/15；TC-MODULES-016/018 的 HTML 显示 `Importing a module script failed`，属于独立 ESM 导入失败，不能归到空列表问题，仍在排查。尚缺 macOS shard 3，不外推该 shard 或整端通过。macOS MFA framework staging 修复已于 `c9fc1f99f` 提交，须新源码正式安装门执行。
- 源码 `2a14e5590f658642d8fcc021b70ee9ff853b39f1` 的 [UI #43875317089](https://github.com/engcapa/taomni/actions/runs/43875317089) 已通过 plan；[契约 #43875439558](https://github.com/engcapa/taomni/actions/runs/43875439558) 的 Linux、Windows 正式签名 MFA 安装门均已成功，原始 job log 各确认 **3/3**，receipt 为 exit=0、固定生产公钥且拒绝 fixture key，绑定 core/package/provenance hash。整轮契约唯一失败是 macOS 安装门：`tauri_build` 编译时检查 `frameworks/libgssapi_krb5.2.2.dylib`，workflow 未执行生产 `beforeBuildCommand` 的 staging；`c9fc1f99f` 复用既有 `bundle-krb5-macos.sh stage`，保留完整默认 features 与安装断言，仍须新源码 hosted 复验。UI 完成 shard 即下载：三端 browser 的 TC-MODULES-017 在第一次空列表等待可见时失败，HTML 确认组件正常挂载且 `<ul>` 已返回空数据、console 无运行时错误。新增实际独立 ESM 单元先复现失败，再补明确的已加载空状态；保留全部保存、reload、启禁、分离和卸载断言，三份用例首次加载改为等待该空状态。相关单元 **23/23** 通过，仍须 hosted 复验；不把该修复算整轮通过。旧源码 #43864283226 的 macOS native 第 3 shard **12/12**，其余分片继续收取。
- 动态前端源码 `c6c0d382c1faa5343a519b20fb75376fdc440fc0` 与安装门环境修复 `2d1f4a66c` 已推送。[契约 #43874332365](https://github.com/engcapa/taomni/actions/runs/43874332365) 正在执行并即时下载 artifact；[UI #43874332771](https://github.com/engcapa/taomni/actions/runs/43874332771) 在 plan 的旧 guard 字符串单元断言失败，没有生成 selection 或执行用例，不能记为通过。该断言依赖已删除的内部变量名；修复为检查 guard 先于唯一 key-bearing 步骤，并把实际精确内容/二级 chunk 篡改单元纳入 UI plan。与 CI 完全相同的纯单元选择 **24/24** 通过，不放宽候选代码/密钥隔离或逐字节校验。MFA 安装 workflow 同时复用现有 sherpa 缓存刷新，避免 rust-cache 保留 build-script 状态却移除原生库；Node 静态契约 1 项通过，2 个真实 MSVC 场景未在本机执行。actionlint、check:refactor 与 diff 检查通过，UI 须提交后重新触发。
- `2975f3401` 的 UI #43864283226 已即时收齐 Linux Xvfb **49/49** 和 Windows **47/47**，各四个 native shard、identity stable；TC-MODULES-013/014/015 的三态还原、第二次重启及 MFA 解密断言通过，Windows TC-MODULES-011 后续的 fixture 清理和 FILE-OPEN-002 均通过。Wayland 四个 shard **47/49**，仅既有 TC-FILE-OPEN-006 非左键输入、TC-FILE-OPEN-008 路径 chip 命中失败；原始失败保留，按用户指示忽略且不计通过。macOS native 仍在执行，不能外推。六个 browser shard 三端各 **42/42**；这些证据不包含后续动态前端增量。
- 动态前端批次已有主窗/独立 WebView 共享 React SDK、memo/forwardRef 支持、owner-scoped IPC、失效取消/晚到拒绝、仅 locator 保存恢复、占位/重试、真实相对 ESM 与分离回挂；实现契约见[前端接入契约](taomni-modular-frontend-contract.md)。新增分离/窗口/回挂/render-error 单元后，主相关 12 文件 **77/77**；后续 memo、回挂 envelope、恢复策略受影响的 4 文件 **26/26**（与前者重叠，不相加）。SettingsPanel/ModuleStorePanel/SFTP 三文件 **31/31** 保留行为通过；原恢复策略 22-kind 断言已更新为保留原 22 + plugin，并断言重新验准入且不重放写操作。分离关闭失败的双副本问题已先复现再修复，回挂时立即撤销原 view，可重试关闭且不重复发布。TypeScript、核心完整默认 feature harness `--no-run`、官方包签名 guard **4/4**、三份 schema/reviewed contract、actionlint/rustfmt、check:refactor 和 QA audit 全 gates 均通过，coverage baseline 未变；没有本地 UI 或真实进程执行。新增 TC-MODULES-016/017/018 为 **100/86/35** 步，分别验证 native 正常生命周期、browser 明确 model、native 篡改拒绝与恢复重试；静态选择为三端 browser 各 **43**、Linux 两 profile native 各 **51**、Windows **49**、macOS **48**，22 shards/3 个 release QA 构建、gaps=[]/unreviewed=[]。这仍是提交前计划，不是新增 case 的执行证据。
- `2975f3401` 的契约 #43864248316 已结束，39 份 artifact 在执行期间收齐。三端真实宿主实际日志均确认 activation **3/3**、cleanup **2/2**、lifecycle **7/7**、MFA **5/5**、MFA snapshot **2/2**、profile **5/5**、services **8/8**、snapshot **4/4**；Linux 实际持久 Vault MFA **3/3**，receipt 绑定同一源码及 core/host hash。四目标签名 MFA 包均已下载，正式安装门三端未通过：Linux 链接缺 `libgbm`、macOS 未配置 MIT Kerberos 导致 GSSAPI IOV 编译失败、Windows harness 启动返回 `0xC0000135`（缺运行时 DLL），尚未进入三个场景。当前未提交 workflow 已补 Linux/macOS 依赖及从本次构建 JSON 定位 Windows sherpa runtime，须新源码复验；不放宽安装/Vault 断言。对应 UI #43864283226 六个 browser shard 已即时收齐，三端各 **42/42**，native 16 shards 仍在构建/执行。
- 当前未提交动态前端批次接入真实主窗与独立分离窗、共享 React SDK、owner-scoped IPC、失效撤销/取消/重试、仅 locator 的保存恢复，以及 hello 独立 ESM 的相对资源。新增 browser TC-MODULES-017 与 native TC-MODULES-016，仍须补齐元数据/边界用例、静态检查与 GitHub 执行；不将 TASK-007 或 MFA 产品迁出标为完成。发现并修复 Rust registry event 的身份字段和 serde nullable entry 的 renderer 兼容问题，后者单元先复现后通过。浏览器显式返回已设计，浏览器 OS 关闭自动回挂与原生 OS 关闭不混为同一验证；截图入口没有插件 view，本批不声称全部独立入口 SDK 已验收。
- 修复及正式签名安装门源码 `2975f3401ee775db7a89f81e1b7bc1b939a170c8` 已推送，[契约 #43864248316](https://github.com/engcapa/taomni/actions/runs/43864248316) 与 [UI #43864283226](https://github.com/engcapa/taomni/actions/runs/43864283226) 已启动即时采集。新源码 Linux 实际 host-process artifact 已下载并核对：activation **3/3**、cleanup **2/2**、lifecycle **7/7**、MFA **5/5**、MFA snapshot **2/2**、profile **5/5**、services **8/8**、snapshot **4/4**。这闭合 Linux 原型初始化的空 result 失败，不替代 Linux 真实 Vault 3 项、其它平台、新正式签名安装或 UI；它们尚在排队/构建。最终本地 QA audit 全 gates 通过（766 files/766 IDs、0 errors），原 baseline 未改；用例 schema/reviewed contract、actionlint、rustfmt 和 check:refactor 均通过。
- `b96d3add1` 的契约 #43858726184 已结束，**23/27 jobs 成功**，28 份 artifact 已在执行期间收齐。三端真实 host 门在 `mfa_initialize_empty` 返回 `UnexpectedResponse`：合法 JSON-RPC `result: null` 被 `Option<Value>` 反序列化为缺失 result。API 修复 `a6a859252` 区分空值与缺失字段，回归单元先失败后通过，保留原进程断言。即时下载的 Linux 真实 Vault 3 项为 **1 passed / 2 failed**：一项同为空结果；另一项发现 MFA 的字符串 KeyProvider adapter 把核心 `PERMISSION_DENIED`（-32004）降为 InvalidState（-32009）。`38dee0a2b` 新增单元复现后在宿主边界恢复精确服务 kind 对应的 RPC code；不修改门禁的期望。Linux 真 X11 采集 **3/3** 已通过，闭合之前 reset 失败；该源码 Linux/Windows browser 各 **35/35** 已即时收齐，其余/native 尚在执行，未记整轮通过。
- 旧源码 `3620dd60a` 的 UI #43853090821 在执行期间又收齐 Linux/Windows 的 TC-MFA-015 失败：点击 pin 后 immediate attribute 读取 false，随后截图和独立 HTML 均为 true，console 无 runtime error。生产 store 在真实 `mfaUpdate` 返回后才发布 pin，原断言用时 0–1ms；用例新增最多 10 秒的精确 `[data-pinned="true"]` 等待，再执行原属性断言。91 个原步骤全部保留、变为 92 步，reviewed 索引同步；reload 后 pin/偏好/HOTP 和确认删除断言不变。三态旧用例失败仍为此前 modal 顺序/Windows fixture 占用，既有 Wayland 输入/hit-test 失败保留并单列；Windows FILE-OPEN-002 的 setup document 未挂载仍保留原始证据，不计通过。当前修复均须新源码多端复验。
- 新增 `qa-modular-mfa-install.yml`，由已有升级 workflow 调用：官方打包器支持 host-only/frontend-only（至少声明一项），官方 workflow 仅允许 `hello-plugin`/`mfa`，候选构建无签名凭据，可信独立 runner 校验精确 manifest/inventory 后签名。四目标 MFA 包配合三端安装 gate，使用非默认 `qa-release-trust-gates` harness 在所有线程固定生产公钥，并显式拒绝普通 unit key；实际经过生产 install/enable/scoped invoke/uninstall/reinstall 和 Vault coordinator。三个 ignored 场景覆盖 HOTP/UUID/key 保留、真实 writer lease、启禁/保留数据重装、代码篡改/多余文件拒绝、换密/锁定/解锁。新增门只在本地编译，执行留 GitHub；Intel macOS 安装执行、系统信任、产品 UI、旧版迁移与最终 G 门仍未覆盖。当前产品路径没有新增 UI 行为；沿用 TC-MODULES-007、TC-MFA-001–015、三态还原与完整 crash-regression，不能用 prototype 进程门代替这些用例。
- 本批本地纯单元：API **17**、SDK **19**、services **36**、host adapter **15**、MFA host **10**，打包器 **9**，原有默认 unit-key 验签 **22**，包/guard/执行记录 Python **16** 全部通过；生产 key feature 的最终 core harness 仅 `--no-run` 编译通过，没有本地执行真实宿主。尝试裁去默认 features 编译时发现既有 voice `Session.capture` cfg 不闭合，已停止该试验并让安装门使用当前产品的完整默认 features；这不是 core-only 交付，TASK-006 仍待闭合。静态 UI 选择扩至全部 TC-MODULES-001–015、受影响 MFA/备份还原及完整 crash-regression：三端 browser 各 **42**，Linux 两种 native profile 各 **49**、Windows **47**、macOS **46**，22 shards、gaps=[]/unreviewed=[]；不是执行通过证据。
- 原型源码 `b96d3add155c95675a7b3207f81e657c831d6c65` 已推送，[升级契约 #43858726184](https://github.com/engcapa/taomni/actions/runs/43858726184) 与 [UI #43858733769](https://github.com/engcapa/taomni/actions/runs/43858733769) 已触发，即时采集器已启动；当前排队/构建，未记新增进程门或 UI 修复通过。本批 `check:refactor`、rustfmt、actionlint、真实 MFA 依赖树、QA audit 全 gates（766 IDs、0 errors）、reviewed case contract 与 dev contract 通过；静态选择含受影响 MFA/备份还原、Windows 后续重置用例和完整 crash-regression：browser 三端各 35，Linux 两种 native profile 各 39、Windows 37、macOS 36，22 shards/3 个 release QA 构建，gaps=[]/unreviewed=[]。这些仅为选择/静态结果，不能替代执行。
- 当前 MFA 宿主原型 `src-tauri/plugins/mfa/` 持有独立 `plugins/mfa/data/mfa.db`，只依赖 engine/API/SDK；使用 operation-scoped 固定 key 服务、核心一次性 export/reset grant、显式独占初始化和零化密钥副本，不接收主密码。串行 actor 的外层事务在取消/错误/panic 时回滚，engine 批次改用可嵌套 savepoint；snapshot 冻结并读取权威连接，普通重启重开旧库，未使用备份不建库、不访问 Vault。新增三端真实进程 5 项、snapshot 2 项及 Linux 真实持久 Vault 3 项，只在本地编译、待 GitHub 执行；engine 13/13、host 9/9、边界 10/10 单元通过，根 unit harness 编译及核心 MFA 14/14 单元通过。没有可信安装包、真实迁移或动态 UI，本批不标 TASK-014/025-H 或相关 G 门完成。
- 源码 `3620dd60a` 的 [UI #43853090821](https://github.com/engcapa/taomni/actions/runs/43853090821) 持续即时收证，三端 browser 各 **34/34**，含 91 步 TC-MFA-015；native 尚在构建，未收齐不外推。对应[契约 #43853084170](https://github.com/engcapa/taomni/actions/runs/43853084170) 已结束，**26/27 jobs 成功**，28 份 artifact 已即时收齐；唯一失败为 Linux X11 真采集 2/3：顺序测试间 Xvfb reset 导致 `x11rb::connect` 被重置，补 `-noreset`，保留全部采集断言，待新源码 hosted 复验。
- 三态还原 #43848528270 的 Linux Xvfb 四 shard 已即时收齐，**26/29**；TC-MODULES-013/014/015 的独立 `restored` 观察均确认原数据、新 generation、激活状态与 writer OS lease，但启动 Vault modal 阻挡进入 MFA，不能记完整解密/第二重启通过。调整为两次重启均先解锁再进入 MFA，并增加 modal 关闭断言，保留错密码拒绝、原密码/755224、账户数与全部生命周期断言，用例变为 96/107/115 步。旧快照 UI #43844254356 的 Windows 后续三例被 TC-MODULES-011 遗留 SQLite 连接阻挡；已确认 native 步骤与 fixture 清理使用不同上下文，改由同一 fixture state 持有连接和 job 集合。新单元在成功/步骤失败两条路径先复现再通过，运行中 WAL 断言保留；相关清理/归档 14 项单元通过，Windows 进程锁项留 GitHub；修复已提交 `18a1a61f9`，待多端 rerun。
- 三态还原源码 `df46031e53c05974fe2a9f87c10b393f9980e2cd` 的[契约 #43848520091](https://github.com/engcapa/taomni/actions/runs/43848520091) 已全部成功，24 份 artifact 在执行期间收齐。Linux 核心 receipt 的 24 个过滤器共选中 338 项、全部 exit=0；三端宿主 services 各 8/8、snapshot 各 4/4，观察工具 Linux/macOS 各 32 项、Windows 31 项通过/1 项平台跳过。对应 [UI #43848528270](https://github.com/engcapa/taomni/actions/runs/43848528270) 六个 browser shard 已即时下载：三端各 **21/21**，含新还原确认与完整 browser crash-regression；native 构建仍在执行，不记 TC-MODULES-013–015 或完整三态还原通过。旧 #43844254356 的 macOS 第二个 browser shard 已取消、缺 1 项结果；Linux/Windows 各 50/50、macOS 已收 49/49，不将取消项记为通过，native 仍待收证。
- #43844254356 已即时下载 Linux Xvfb 三个 native shard（39/39），其余仍待结果；Wayland 四个 shard 已齐，**48/52**。两种 profile 的 TC-MODULES-011/012 全部通过，live observations 确认两次不同备份 job、同 generation、独立 ZIP/hash/SQLite 内容和正常重启后 writer OS lease 仍被真实持有。Wayland 四个失败与已记录 baseline 相同：SERVERS-002、FILE-OPEN-006、WS-030 为非左键输入仅支持 owned X11；FILE-OPEN-008 为已有路径 chip hit-test。按用户指示单列忽略且不计通过，原始失败保留；Windows/macOS native 未收齐不外推。
- 当前 MFA 引擎拆分批次：新增 `taomni-mfa-engine`，按 DTO、输入校验、OTP、AES-GCM、key-check、账户查询/写入/偏好和业务操作拆分。现有 Tauri 命令委托 engine；核心仅保留过渡连接 owner、Vault 准入/授权、备份和共享采集适配。保留 IPC、schema v1、AAD、固定 key ID、错误码、UUID/毫秒时间戳与原有 Vault 集成断言；不把本批标为 MFA 独立宿主交付，核心仍依赖 engine。下一边界是正式 SDK 的 operation-scoped KeyProvider、MFA store actor/snapshot、可信包/迁移及动态 UI；其 G 门按设计先闭合。
- 本批拆分前原有 MFA **19/19** 单元基线通过；五项纯 OTP/校验断言原样迁到 engine，真实 Vault、备份、capture、导出口令与 protected-entry 断言留在核心。engine 当前 **13/13** 单元通过，新增原子批量导入/重复回滚、metadata/偏好、无密钥首次探测、缺失/错误 key 拒绝、显式 reset 与独立 AES-GCM 固定 v1 密文解密。边界单元 **9/9**、真实依赖树无 Tauri/Vault/SDK/runtime、actionlint、case schema/reviewed contract 与 `check:refactor` 通过；拆分后的核心 MFA 集成单元 **14/14**、受影响 protected snapshot/MFA 还原单元 **7/7** 通过；完整 QA audit gates 通过（766 cases/766 IDs、0 errors，保留原 baseline）；尚未取得本批 matching hosted 证据。
- 新 `TC-MFA-015`（91 步，browser/native）：从 UI 创建并递增 RFC HOTP，拒绝别名重复且保持 counter=1，保存编辑/备注/置顶/排序/分组，WebView reload 后核对原验证码与偏好；取消删除保留账户，确认删除再次 reload 仍为空且无 runtime errors。该用例使用真实 native IPC/存储，但不等同正常进程重启或 MFA 独立宿主。policy/dependencies/feature-list 同步；升级 workflow 新增四发布目标的 engine check、runner 架构 unit 与 runtime/build cargo tree 边界，执行结果待提交后 GitHub 收证。
- 超时修复源码 `4c060a939702cea5045f1b3b6a2acc3e7ea8580a` 的[契约 #43844240041](https://github.com/engcapa/taomni/actions/runs/43844240041) 已 **23/23 jobs 成功**，24 份 artifact 在执行期间收齐。三端 services 各 **8/8**、snapshot 各 **4/4**；Windows 原超时竞态、终止凭据与 writer OS 锁释放断言通过。匹配源码 [UI #43844254356](https://github.com/engcapa/taomni/actions/runs/43844254356) 已开始执行、即时采集器已工作，Linux browser **50/50**；其余未收齐的分片不外推。旧 UI #43841954615 已由 REST cancel 终止，避免为已替代源码重复构建；原失败和已完成证据保留。
- 下一批补充 `TC-MODULES-013/014/015`：分别在运行、禁用、卸载保留数据时取得精确手工 v2 档案，之后经真实业务修改 hello、递增 HOTP 并修改 Vault 主密码；固定生产 IPC 验证错密码不留下 pending，再正常关闭/冷启动应用，断言原数据、原密码/755224、新 generation、原启用状态和代码指针，第二次正常重启保持新 generation。尚未 hosted 执行，不算真实还原通过，也不代替 MFA 独立宿主后的 TC-MODULES-020–022。
- 新 `TC-BACKUP-RESTORE-001` 验证浏览器还原确认的空密码、错密码、成功暂存和禁止重复确认。补稳定控件标识与明确的 preview archive/stage model；正确恢复和原生加密均不由该 model 模拟。预期密码拒绝展示现有界面错误，不再作为 runtime console error；未知错误保留日志。native 三态用固定生产 stage IPC 配合现有正常重启，**不声称已经验证确认按钮自动 relaunch 的原生接管**；该入口仍为发布前待办。
- 本批新增还原用例提交前验证：前端相关 **22/22 单元**、还原观察工具 **5/5**、behavior contract **6/6**、既有 live snapshot 观察 **3/3** 通过；TypeScript、actionlint、四份 case schema/reviewed contract 与完整 QA audit gates 通过，未改 coverage baseline。三态 native 用例分别为 94/105/113 步，browser 为 45 步。静态选择为三端 browser 各 21、四种 native profile 各 29，22 shards、3 个 release QA 构建，gaps=[] / unreviewed=[]；仅为计划，执行结果待新源码 GitHub 证据。
- 运行中快照源码 `a57009a8201e9a6c113a0e74448f1b4f5548db97` 已推送，[契约 #43841946054](https://github.com/engcapa/taomni/actions/runs/43841946054) 与 [UI #43841954615](https://github.com/engcapa/taomni/actions/runs/43841954615) 已启动即时采集。Linux、macOS 新增 snapshot target 各 **4/4 真实进程场景通过**；Windows 在此前的 services target 暴露原超时路径竞态，尚未执行 snapshot target，不能外推通过。UI 当前尚在排队，无新源码 browser/native 结论。
- #43841946054 的 Windows `expired_operation_terminates_transport_before_a_late_key_can_be_published` 返回正确 -32007，但宿主仍为 Running：core timer 路径收到 SDK cancel ack 后允许复用，permit 先过期的另一条路径却会回收。修复使带密钥 operation 的 core 超时一律 retire 原认证通道，普通请求与显式取消保留已有 ack 语义；原真实 gate 不放宽，并增加旧 host termination receipt 和 writer OS 锁释放断言。宿主适配 15 项纯单元通过，真实门禁待后续修复源码 GitHub 重跑。
- 真实 Vault/SDK harness 的 profiled 启动修复源码 `6d8e2ab293bfe6dc9e944893c73548445e524b7f`，[契约 #43836198487](https://github.com/engcapa/taomni/actions/runs/43836198487) 已 **23/23 jobs 成功**。该结果闭合前述 #43832212768 的相关失败，包含实际 profile/writer OS 锁占用断言；不覆盖当前未提交的运行中宿主快照增量。短 SHA 误触发的 #43834894177 仅 checkout 失败、没有执行测试，不计作产品验证。
- `44e6f2b80` 的 [UI #43833397073](https://github.com/engcapa/taomni/actions/runs/43833397073) 在执行期间已下载 Linux Xvfb 四个 native shard，**23/23 cases 通过**，含 TC-MODULES-011 的完整 58 步。macOS TC-MODULES-011 step 41 新失败为设置页搜索延迟滚动将卸载按钮再次移到裁剪区域：截图可见 Settings viewport 底部，按钮矩形仍在 WebView 内但不能命中。修复仅在目标几何变化后重新滚动，仍要求稳定 `elementFromPoint` 命中，不重放按钮输入或合成激活；相同竞态单元先失败再通过，pointer 全部 50 项单元通过，真实 macOS 结果待新源码 runner。Wayland FILE-OPEN-006 的既有非左键输入限制和 FILE-OPEN-008 的路径 chip 失败按用户要求单列忽略，不计通过；其它尚未收齐的 shard 不外推结果。
- 运行中宿主快照增量正在准备提交：SDK 串行 store actor 持有 prepare/snapshot/release 屏障、绑定 job/generation/host/barrier/staging，失败/取消/过期/EOF 恢复 writer gate；核心冻结所有已运行 owner，核对完整 inventory/hash/SQLite，再从同一个验证句柄复制到私有 staging，在 Vault 完成后显式 release。hello 示例恢复已有库的权威连接，未使用时仍不建库。新增四项三端真实进程 gate 与 34 步 TC-MODULES-012，两次真实写入和不同手工 job、正常重启与 writer OS 锁断言均保留；browser 设置行为沿用 TC-BACKUP-SETTINGS-001。上述协议和 native 用例尚未取得匹配源码 hosted 证据，不记 TASK-025-F/G 完成。
- 本批本地单元与静态检查：根应用备份 **98 passed**、插件 **128 passed / 3 ignored**；SDK **19**、独立宿主适配 **15**、hello **4** 项通过（宿主适配与根插件包含重复范围，不混加总数）。QA 观察工具 22、pointer 50、行为映射 6 项单元通过；根 unit harness 编译成功，新增 ignored process target 仅编译。扩大 `backup::` 单元过滤器时误纳入一个内部启动子进程的既有跨进程锁测试；该次实际执行已向用户说明，后续本地命令显式排除，不能将本轮称为完全无子进程的本地验证。新增进程门禁和全部 browser/native 仍只在 GitHub 执行。33 个 Rust 文件格式、actionlint、check:refactor、两份 case schema/reviewed contract 与完整 QA audit gate 通过。静态选择为三端 browser 各 50、Linux 两种 profile native 各 52、Windows native 50、macOS native 49，22 shards / 3 个 release QA 构建，gaps=[]；执行结果待 GitHub 收证。
- 宿主自持锁源码 `1980436f3e0b4dee800d1244fd92588c18498749` 的[契约 #43832212768](https://github.com/engcapa/taomni/actions/runs/43832212768) 已结束：22/23 jobs 成功。Linux 的两项真实 Vault/SDK gate 沿用无 profile 启动，而新版 fixture 要求在创建 store 前已持有 profile/data 锁，导致握手前退出；修复 harness 通过生产 generation 初始化与 `start_profiled`，并增加实际锁占用断言，保留全部旧密钥字节/授权断言，待新源码 hosted 复验。其[UI #43832220984](https://github.com/engcapa/taomni/actions/runs/43832220984) 仍逐 shard 收证，不记整体通过。
- `TC-MODULES-011` 相对观察路径修复已以 `44e6f2b80` 推送，[UI #43833397073](https://github.com/engcapa/taomni/actions/runs/43833397073) 已开始执行并启动即时采集器，等待 matching native 结果。运行中宿主快照协议正在开发，未提交和验收。
- 测试修复源码 `852edd943503343689e3d2f42d12d886ef4df008` 的[契约 #43830091552](https://github.com/engcapa/taomni/actions/runs/43830091552) 已 **23/23 jobs 成功**；macOS SQLite 11 项（含链接路径拒绝）、Windows observation cleanup 已 hosted 复验。其[browser/crash #43830100774](https://github.com/engcapa/taomni/actions/runs/43830100774) 持续即时收证，Linux/macOS 分片的修复用例已通过，整轮尚未完成。
- `fad6a56ab` 原生 shard 在执行期间发现 TC-MODULES-011 step 28 的观察工具错误：真实任务和 ZIP 清单/hash/文件字节检查已完成，打开独立 SQLite 时 `Path(ctx.case_dir)` 为相对路径，`as_uri()` 拒绝。修复为解析现存绝对 case 目录，并新增相对目录单元（Windows fixture 与 checkout 同盘）；保留全部 SQLite/源 WAL/两次 job/正常重启断言，待新源码 native 复验，不能据此宣布 v2 原生通过。
- 源码 `fad6a56ab046e5765e98e88bac4fd227d00e1cfc` 的[升级契约 #43826742393](https://github.com/engcapa/taomni/actions/runs/43826742393) 已结束：21/23 jobs 成功，macOS foundation 的两项 SQLite WAL 单元因 `/var` 临时目录别名触发 NOFOLLOW 拒绝，Windows observation unit 因 SQLite 连接未关闭导致临时文件清理失败。两者均属本批相关失败；修复为 canonical 测试根目录和显式连接生命周期，不放宽源路径/归档断言，并补 Unix 链接数据库/父目录拒绝回归，待新源码 hosted 复验。
- 相同源码的[UI #43826748476](https://github.com/engcapa/taomni/actions/runs/43826748476) 持续即时收取完成 shard，三端 browser 各 49/50；共同失败为 TC-BACKUP-SETTINGS-001 云端仍包含模块数据却尝试取消必需 Vault。用例补先断言依赖、再取消云端模块数据，94 → 96 步，保留全部原断言。三端 native 构建仍在进行，新增 TC-MODULES-011 尚无完整通过结论；不取消该轮以保留真实离线备份证据。
- 源码 `fdd05d232b27a1857fa58a08588de3ab2bfdfe49` 的[升级契约 #43819768258](https://github.com/engcapa/taomni/actions/runs/43819768258) 已 **23/23 jobs 成功**。Linux receipt 确认 21 个过滤器均非空且 exit=0。[UI #43819770975](https://github.com/engcapa/taomni/actions/runs/43819770975) 已收齐 22 个 shard：三端 browser 各 **50/50**、Linux Xvfb native **50/50**、Windows native **48/48**、macOS native **47/47**。Wayland native **46/50**，四个无关失败与下项相同，单列忽略且不计通过。新增 TC-MODULES-010 已覆盖四种 native profile；该结果不覆盖之后的离线模块备份/还原或宿主自持锁。
- 源码 `c5c42bbb2` 的 [UI #43815220663](https://github.com/engcapa/taomni/actions/runs/43815220663) 已收齐 22 个 shard：三端 browser 各 **50/50**，Linux Xvfb native **49/49**、Windows native **47/47**、macOS native **46/46**。Wayland native **45/49**；SERVERS-002、FILE-OPEN-006、WS-030 因既有非左键输入仅支持 owned X11，FILE-OPEN-008 因已有跨行路径 chip 命中失败，按用户指示单列忽略且不计通过。TC-WS-051 此轮通过。TC-MODULES-009 与 Vault/MFA 013/014/102/103 的结果以该源码实际用例报告为准，不再沿用更早批次的“待重跑”状态。
- 最新待验源码 `c5c42bbb2` 已推送，包含核心 permit 生命周期修复 `be14572e3` 和 TC-MODULES-009 的隐藏状态断言修复；[升级契约 #43815221797](https://github.com/engcapa/taomni/actions/runs/43815221797)与[UI #43815220663](https://github.com/engcapa/taomni/actions/runs/43815220663)已启动即时采集器。当前批次完整 QA audit 的所有 gates、check:refactor、rustfmt、case schema/reviewed contract 与 dev_contract 均通过；这些检查不代替 hosted 执行。
- `cf0fb2033` 的 UI #43813458259 已在执行期间收齐六个 browser shard，Linux/Windows/macOS 各 **50/50**，含 TC-BACKUP-SETTINGS-001 的相关修复和完整 browser crash-regression。其 native 构建仍在进行；该 run 的 TC-MODULES-009 尚为旧断言，最终以新源码重跑为准。相同源码的升级契约 #43813432137 为 22 个 job 成功、Linux 核心 job 被新一轮 concurrency 取消；收取的 receipt 最后完成 `vault::plugin_access::tests`，下一过滤器为存在前述同步竞态的 `vault::data_access_tests`。未完成的过滤器不计通过，整轮不记为成功。
- 一致快照和前端门禁修复源码 `cf0fb2033` 已提交并推送，启动[升级契约 #43813432137](https://github.com/engcapa/taomni/actions/runs/43813432137)与[UI #43813458259](https://github.com/engcapa/taomni/actions/runs/43813458259)。两套即时采集器已启动；完成的三端 foundation 日志均确认 services 35 项通过，三端真实 host activation/cleanup/lifecycle/SDK 分别为 3/2/7/8 项通过。整轮仍在执行，不包含之后工作区的 core permit 生命周期修复。
- 源码 `1b5de48d9` 的[升级契约 #43809632572](https://github.com/engcapa/taomni/actions/runs/43809632572) 已 **23/23 jobs 成功**。该批包含 Vault IPC/普通消费者和 MFA facade；Linux 的真实 harness receipt 为所有 19 个过滤器非空且 exit 0，三端 SDK/下载/宿主/observation 与四目标基础检查通过。产物已在执行期间下载至 `qa-ui-auto-report/github/43809632572/live-contracts/`，不包含之后开发的快照 pause。
- 相同源码的[UI #43809656351](https://github.com/engcapa/taomni/actions/runs/43809656351) 已即时收齐三端 browser 各 49/50；新增 TC-MFA-013/014 及完整 browser crash-regression 通过。唯一相关 browser 失败是 TC-BACKUP-SETTINGS-001 step 14：移除 LanChat 时替换成 MFA 后沿用错误的默认排除断言。既有 `rangeOptions` 的 core 默认包含 MFA，故修正为包含，保留后续自定义排除、Vault 依赖及持久化断言；待新 SHA 重跑。macOS native 已进入执行，Windows 仍在构建。Linux 在全量前端 unit 门禁失败，未进入 native，不外推通过。
- Linux 构建 job `133109555494` 的日志已在 run 执行期间经 jobs/logs API 收取：相关失败是 MainLayout 测试的 Vault mock 缺少新增的 `subscribe`，已在本地复现并补齐 fixture；另一失败为编辑器双叶 caret 测试只等待至少一个编辑器，却立即读取第二个，修复为 `findEditorPanes(2)`，保留 `[10, 40]` 的精确断言。两项修复以 `f9c160921` 提交，本地定向 unit 55 passed（其余 260 项按过滤器未执行），待匹配源码 hosted 复验。
- #43809656351 已即时下载 macOS 与 Windows 各四个 native shard，分别 45/46、46/47；TC-MFA-013/014、102 与 TC-MODULES-007 通过。两端唯一失败均为 TC-MODULES-009 第 14 步新加的 DOM 数量断言。macOS 截图与 HTML 显示 Notes drawer 已是 `display:none; aria-hidden=true`，`origin/main` 的 `chat/drawer/dock.ts` 也明确保留挂载；修复为等待 drawer hidden，28 步与所有正常退出/进程身份/笔记/generation 断言保留，schema/reviewed contract 已通过，待新 SHA hosted 重跑。Linux 被已列明的构建门禁阻断，不据此报告整套 native 通过。
- 源码 `064a12662` 的[升级契约 #43801588646](https://github.com/engcapa/taomni/actions/runs/43801588646) 已 **23/23 jobs 成功**。三端 observation 各 8 项通过，确认 canonical 临时目录修复；artifacts 在执行期间下载至 `qa-ui-auto-report/github/43801588646/live-contracts/`。该 run 不含当前工作区未提交的 Vault/MFA 协调器开发。
- 源码 `911f411b2` 的[UI #43800287415](https://github.com/engcapa/taomni/actions/runs/43800287415) 仍在运行。已即时收齐三端 browser 各 24/24；Linux Xvfb native 28/29，Wayland 26/29，两种 Linux 的 TC-MODULES-009 均通过。TC-MODULES-007 已通过首次启用、禁用/再启用与 Settings 重开，在第一次正常重启时触发仍打开的一个 Settings tab 所需退出确认；macOS 已完成的对应 shard 也是同一步失败。
- TC-MODULES-007 的失败前 HTML 与 restart receipt 已核验：标题 `Exit`、消息 `There is 1 open tab. Exit Taomni and close it?`、确认按钮 `Exit`。用例仅在已知 Settings 仍打开的首次和卸载后重启声明精确确认，沿用现有单次真实点击、正常退出与进程身份检查；不允许通用弹窗兜底或强杀当作成功。该 case 修复尚待新 SHA hosted 重跑。
- Wayland 的 FILE-OPEN-008 跨行路径命中和 FILE-OPEN-006 非左键输入仅支持 X11 的两个既有失败继续按 main 对比依据单列，不计通过。Windows/macOS 尚未完成的 shard 不外推为通过。
- 当前 Vault/MFA 开发开始接入真实 core operation permit、revision 校验、可重试撤销和显式 reset 屏障；其它核心 Vault 消费者、统一 snapshot/restore 和业务宿主迁出仍未闭合，不把这一开发状态记为 TASK-025-D/E 已完成。
- 源码 `900ed0146` 的[UI #43804951477](https://github.com/engcapa/taomni/actions/runs/43804951477) 已 completed/failure；22 个 shard 均在执行期间下载并逐份分析，最终用例结果见下项，不把下载成功算成用例成功。
- 旧 UI #43800287415 的 Windows TC-MODULES-009 在正常关闭前失败。即时下载的 `native-restart-failures/*/close-target.json` 与画面一致：窗口关闭按钮中心上层是仍打开的 `ai-chat-drawer-hide`，不是退出清理或数据损坏。用例保存 Notes 后先真实关闭并断言移除 drawer，再走原生正常退出；重启后仍重新打开 Notes 验证原内容与 generation，随后关闭 drawer 后进入 Settings。没有绕过指针命中、强杀或放宽持久化断言，该修复待新 SHA hosted 验证。
- #43804951477 的最新逐 shard 结果：三端 browser 各 24/24；Linux Xvfb native 29/29，macOS native 29/29，Windows native 28/29（仅同一 TC-MODULES-009 overlay 命中失败），Wayland native 27/29（仅两个已列明的无关 FILE-OPEN 失败）。TC-MODULES-007 在四种 native profile 全部 52 步通过。上述结果对应 `900ed0146`，不包含之后的 TC-MODULES-009 修复或 Vault/MFA 改动。

### 插件离线备份与还原批次（待匹配源码 hosted 验证）

- TASK-025-F/G 的离线路径已接入真实备份引擎：在同一 Vault snapshot barrier 与 job/profile generation 下，扫描安装、禁用和卸载保留数据的严格 owner 子树，取得 PluginDataLease，重新枚举实际文件。普通文件通过普通文件句柄复制；SQLite 使用只读 online snapshot，保留已提交 WAL 内容且不打包 sidecars，不初始化业务库或 key。已知 SQLite 头部损坏明确失败，不降级为普通文件。
- 有插件数据才生成 format 2 `pluginDatasets`；没有插件数据继续生成 format 1。数据集精确绑定 payload、owner、schema、job、generation 和核心推导的 Vault 依赖，拒绝大小写/文件目录冲突、越界路径、sidecars 与 metadata 扩权。读取器独立比对 SQLite 头部和声明类型，并在 staging 检查数据库。旧版读取器不支持模块 v2 档案，不能用于还原该档案。
- 还原在 stage 与启动 apply 前都检查 Vault/MFA 依赖；整套模块旧文件、过期 sidecars、重建的 retained locator、核心库共用兼容 journal。支持文件/目录互换；代码、active 指针、权限和信任不由数据档案恢复。回滚在删除新文件前确认所有旧安全副本可读且哈希正确，副本缺失/损坏保留现有可读数据和 journal，允许修复后重试，generation 不回退。
- 设置页默认包含模块数据，选中时强制包含 Vault；旧 custom 未指定模块项继续排除。增强 browser TC-BACKUP-SETTINGS-001（首次提交 94 步，相关失败修复后 96 步），新增 58 步 native TC-MODULES-011：真实签名安装、启用再禁用、禁用/卸载后分别创建不同手工 job，独立核验 ZIP/SQLite/WAL/原始字节，生产归档读取与取消不留下还原 intent，正常重启保持卸载状态。用例在打开历史归档前核对精确 job 文件名，不能用旧任务成功满足新任务断言。
- 当前最终 Rust harness 已编译通过；前端范围/编辑器/持久化 3 文件 **19/19** 通过；插件备份 15、既有备份 14、兼容档案 2、核心成对快照 5、旧快照 7、generation 1、范围 2，合计 **46 项单元通过**。SQLite snapshot 小库 **10/10**、QA 工具 **12/12** 通过。两份 case 的 schema/reviewed contracts、三端/四种 native profile 静态选择、TypeScript、check:refactor、25 个变更 Rust 文件的 rustfmt 与完整 QA audit gate 通过，coverage baseline 未修改。本节不将计划或本地单元计为 hosted 用例通过。
- 尚未完成：运行中宿主 prepare/snapshot/release（当前明确拒绝，不静默读文件）、真实宿主持 profile lease、GUI/headless 完整协同、三态正常重启 apply 与真实解密，以及 MFA 迁出后的 v1 legacy alias 映射。TC-MODULES-011 只证明离线快照和读取/取消，不证明 applied native restore；TASK-025-F/G/H/I 均不标完成。

### 真实宿主 profile/data 所有权批次（已实现，待匹配源码 hosted 验证）

- 生产 registry 总经 `HostProcess::start_profiled` 提供核心确认的 canonical profile、owner 和当前 generation；每次 spawn 清除外部继承的 profile 环境。宿主自身先取 shared ProfileUseLease 与 exclusive PluginDataLease，只读有限 coordination metadata，generation/编译期 identity 不匹配即拒绝；握手必须精确确认，不接受旧宿主缺省 ack 后继续激活。
- SDK 增加 store 初始化 factory，先取锁再创建 handler/store；工作 reader EOF 后，未完成的业务 worker 继续持锁，handler/store 析构后才能释放最后一份 lease。hello 同步宿主在创建其业务状态前取得并保持同一所有权。旧无 profile 的 stateless/stream 契约保持兼容，生产 registry 不走该入口。
- 三端 hosted process gates 新增五个真实场景：core 的模拟 shared lease 释放后真实宿主仍阻止 restore/第二 writer；stop/crash 释放与 restart 重新持有；既有 writer 可重试；restore/stale generation 不改数据；缺 profile ack 的旧 host 在 enable hook 前被回收。现有八个反向服务场景也全部改走 profiled SDK factory，初始化时检查实际 OS 锁。
- TC-MODULES-007 保持原 52 步并增强 reviewed R5：每次 native registry/ping 检查后，独立尝试固定 profile 下的真实 writer OS 锁；启用必须忙、禁用/篡改拒绝/卸载必须可取并立即释放。不创建锁文件、不改业务数据；该 probe 不能识别 profile shared 锁由 core 还是 host 持有，后者只由独立进程 gate 验证。
- 本地真实根 harness 已编译，plugin 纯单元 **127 passed / 3 ignored**（三个真实网络仍交 hosted）、generation **4/4**、protected snapshot **5/5**；小库 API **16/16**、SDK **11/11**、host adapter **15/15**、hello **4/4**。Python signed/retained/backup/profile 观察工具 **18/18**。真实进程场景只编译、未在本机执行；最终 check:refactor、完整 QA audit 和新源码 browser/native/crash 仍按提交前后分别收证。
- 这批只闭合宿主持有期的所有权接线，不代表运行中 prepare/snapshot/release、GUI/headless 全协同、三态真实重启还原、MFA 独立业务或 G11 整体通过。

### Vault/MFA 协调与保留行为批次（历史开发记录，最新结果见上方）

- `plugin/vault_lifecycle.rs` 将 init、unlock、lock、change-master 与恢复前主密码验证接入同一 coordinator：transition → registry lifecycle 的有界锁顺序，关闭准入、取消、撤销/确认宿主退出、drain 后才处理 root。失败保留 revocation；重试加入同一次撤销并保留已确认成员。核心退出也排空 permit 后清 root；嵌套 quiescence 只在最后一个 guard 释放且 root 仍有效时恢复服务。
- `vault/{passwords,commands,data_access,core_access}.rs` 按密码生命周期、IPC、普通凭据访问和 typed MFA 固定密钥拆分。所有既有普通 `put/update/put_fixed/get_fixed/resolve` 消费者经共享准入和外层 lease；不把 registry/host 反向引用放入 Vault。metadata revision 失配清 root 并关闭 epoch，reverse key 服务也使用同一失配处理。非敏感列表与普通删除的锁定行为保留；受保护 MFA key 拒绝通用 update/delete。
- MFA 的 crypto 只依赖 typed `KeyProvider`，生产 facade 在 MFA DB mutex 之前取得 permit/lease。空库首次建 key 先释放 shared，再取得 exclusive 并重查空库；显式 reset 关闭普通准入并 drain，使用一次性 repair 授权；普通 permit 不能 reset/导出或替换坏 key。导出仅验证主密码，不重开 root 或准入。固定 ID、32 字节 Base64 与旧密文/OTP 格式保留，尚未迁出真实宿主。
- renderer 的 Vault security epoch 在密码转换/reset 请求时立即清理敏感结果。MFA 标签与悬浮窗、HOTP/排序回滚/usage、QR 编码/导出/自动复制拒绝旧 epoch 的迟到回复；原生返回 VAULT_LOCKED 时先清旧内容，再刷新状态，只有显式验证成功才解除门禁。前端相关 10 文件 51 项 unit 已通过。
- 新增 browser/native `TC-MFA-013`（标签+悬浮窗锁定/错误口令/原 HOTP 恢复）与 `TC-MFA-014`（真实改密、旧口令拒绝、计数/secret 连续性），增强 `TC-MFA-102` 的全 DOM 敏感内容清除及 runtime 断言。schema/reviewed contracts 已通过，policy/dependencies/feature catalog 同步；尚未取得执行证据，不能由 unit 或 schema 代替 native。
- Vault 设置页捕获锁定屏障的 busy/超时错误并展示，转换期间禁止重复点击；失败维持 renderer 门禁，允许显式解锁恢复。新增该行为的 1 项单元通过，连同前述测试共覆盖 11 文件 52 项（分批执行，非一次全套执行）。最终 Rust harness：plugin 111 passed / 3 ignored、旧 MFA 13、MFA facade 6、Vault 17、普通 Vault 消费者 4、reverse Vault adapter 4；生命周期 7 项包含于 plugin 结果，不重复累计。services crate 31 项通过。
- 最终 QA audit gate 通过，未修改 coverage baseline；静态选择 50 个明确 case 与完整 crash-regression 并集，22 个 shard、三套 release QA 构建，`gaps=[]`、`unreviewed=[]`。这些是执行计划和单元证据，不替代新源码的 hosted 测试。
- 长期运行问题：core permit 曾与 host 共用 epoch 内 `seen_operations` 的 65,536 上限。后续工作区已将无 wire context 的可信 core 操作改为仅保留存活 ID、Drop 释放，仍共享全局 in-flight/epoch/取消/drain；不删除 host 的历史 ID、防重放或敏感 completion 保护。65,538 次连续本地取码准入等效压力及撤销场景通过，services crate 36/36 单元通过；最终根 harness 编译成功，plugin 118 passed / 3 ignored、MFA facade 6、普通 Vault 消费者 4、成对快照 5 项通过。该修复的新 SHA hosted 证据仍待取得。未来真实 MFA 宿主仍须处理 host admission、ServiceSession 与 SDK 的长期 ledger/counter 上限，不能只扩大限额。
- 本批复验发现普通 Vault 写入/锁定 unit 的同步竞态：文件 shared lease 取得在 operation 登记之前，仅观察文件锁可能让锁定先排空后等待测试自己持有的 Vault mutex。测试现先等待真实 `in_flight_count()` 非零，再验证独占锁被阻止并触发锁定；保留锁定超时、root 保留、迟到写入拒绝、解锁后无脏数据的全部断言。修复后上述 4 项通过，原竞态场景另连续复验 5/5；此前挂起的那次执行已终止，不计通过。
- 尚未闭合：统一 snapshot/restore 跨库一致性、三态真实备份还原、存量 0.5.x exporter/可信 MFA 包、宿主业务迁出与最终 G 门。当前只接通迁出前适配，不能将 TASK-014、025 或生产发布标为完成。

### 当前 Vault/MFA 一致快照批次（`cf0fb2033` 已提交，hosted 执行中）

- 提取 `backup/protected_snapshot.rs`，在 mail/store mutex 之前为当前核心 MFA 与 Vault 取得统一屏障，按 MFA → Vault 顺序在同一独占 OS lease 内产快照；释放后再处理普通库、打包、加密和上传。两库在私有 staging 子目录中一起准备，任一失败/取消清理该子目录，归档路径与格式保持不变。
- 服务层的 RAII pause 阻止新 core/host 准入并等在途响应/敏感 writer 释放，保持 epoch 与已有 permit 有效。等待者在 OS lease 和 store/host mutex 之外等待；失败/取消也解除 pause。实际锁定/rekey 保留原撤销语义，发现外部 rekey 的旧 root 不重新开放。
- Vault/MFA 使用已有 SQLite online backup helper，目的地校验并原子发布；未打开的 MFA 文件只读打开、包含已提交 WAL，不创建/迁移源 schema。旧 VACUUM INTO 消费者和测试保留。新的 services 单元 35/35、备份范围/面板前端 3 文件 17 项通过；当前 Rust 源码的核心 harness 已编译成功，plugin 118 passed / 3 ignored（含屏障 7 项）、成对快照 5、旧快照 7、MFA 还原安全副本 1、MFA facade 6、普通 Vault 消费者 4、Vault 17、MFA 13 项均通过。3 项真实进程测试未在本地执行。完整 QA audit 的全部 gates 通过，coverage baseline 未修改。
- 增强 TC-MFA-103：锁定后创建精确手工 job 的归档，核验两库、保持 locked、显式解锁后重新读取原账户与 runtime 断言。与修正的 TC-BACKUP-SETTINGS-001 均已通过 schema/reviewed contract；执行证据仍待新 SHA GitHub。
- 这批只保护仍在核心内的真实 MFA/Vault。插件 prepare/snapshot/release、禁用/卸载 retained locator、三态还原与真实 0.5.x 升级仍未实现，TASK-025-F/G/H/I 不标完成。

## 任务状态

| 任务 | 状态 | 尚需交付的结果 |
|---|---|---|
| TASK-001 基线 | 部分 | 四个发布目标的真实安装包尺寸、启动/内存/吞吐原始样本；源码与依赖起点已有记录。 |
| TASK-002 契约 | 部分 | API、manifest/schema、registry、RPC 已有；待真实插件与 G 门验证后冻结。 |
| TASK-003 共享采集 | 已提交，hosted 验证中 | 引擎/权限/像素/一次性采集已下沉 `taomni-capture`，核心 `capture/` 持有显示器/帧源/窗口生命周期；仅保留 headless 建表例外。四目标 check、三平台库 unit 与 Linux 三个真实 X11 测试已通过，真实截图/MFA/Mobile/RDP/性能及完整 UI shard 仍待结果；`capture.still` 宿主大载荷 RPC 仍依赖 TASK-002。见下方测试设计。 |
| TASK-004 RDP 公共库 | 代码已集成，待 hosted 验证 | `taomni-rdp-common` 与零依赖的 `taomni-file-uri`；客户端与服务端共享能力只经库依赖，config 直接用通用 URI 库。基于 `0f4cdf82f` 的集成单元完整功能 39/39、关闭 bitmap 30/30 及边界检查通过；四目标/三平台和精确保留场景待本提交 hosted 证据。见下方 TASK-004 记录。 |
| TASK-005 核心状态 | 005-A 已集成，待 hosted 验证 | CoreState、LegacyFeatureRuntime、统一 bootstrap、弱观察器与退出清理已集成；005-A 尚待服务准入接线及 TC-MODULES-008/009 多端证据，005-B 的真实业务状态迁出仍未完成。 |
| TASK-006 核心依赖闭包 | 待开始 | Cargo 默认 features、bundle/resources、平台依赖与核心前端 chunk 真正移除已迁移业务。 |
| TASK-007 前端注册和路由 | 部分 | loader/helper 已有；接入主窗口/分离窗口实际 tab、完整性校验、缺失/禁用/坏 chunk 与卸载清理。 |
| TASK-008 宿主监督 | 已提交，部分 hosted 通过 | 主动心跳、重启预算、请求取消及三平台进程树回收已接入；GitHub 三平台各 14 项 unit 与 7 项真实进程测试通过，双向核心服务与 profile 协同仍待后续任务。 |
| TASK-009 生命周期 | 部分 | 版本目录、active 指针与生命周期 IPC 已有；接可信安装门、运行中切换/回滚、无重启生命周期。 |
| TASK-010 商店/下载 | 部分 | 原生 HTTP、代理、Range/校验、路径与内容去重、退出取消等待、续传和进度 IPC 已有，三端每端 13 个真实网络 gate 已通过；远端商店、代理设置 UI、跨应用重启恢复与完整错误恢复尚待完成。 |
| TASK-011 验签安装 | 基础闭环四种 native profile 通过 | pinned key 的真实 minisign 校验、清单防回滚、安全解包、内容绑定及安装入口强制验签已接入；#43804951477 的 TC-MODULES-007 在四种 native profile 全部 52 步通过，覆盖官方签名安装、启禁、正常重启和篡改拒绝。业务包、更新/回滚与最终发布仍需后续证据。 |
| TASK-012 单体升级 | 部分 | 从安全 pending 进入真实 legacy exporter、可信包 staging、Vault 交接、激活、恢复/回滚；真实安装升级证据。 |
| TASK-013 原型与 G 门 | 部分 | hello fixture 已有；真实 MFA 原型和 G1–G11 多端实验与原始证据。 |
| TASK-014 MFA | engine 与 SDK 宿主原型已提交，待 hosted | engine 与独立 store actor/KeyProvider/snapshot 原型已有，现有 facade 仍在核心内；新增真实进程门待 hosted。可信包/真实迁移、动态 UI、相关 G 门和迁出后的三态还原均未闭合。 |
| TASK-015 | 已取消 | 历史设计 `7bc498b35` 中为 LanChat 迁移，已由用户明确删除决定取消；主设计已保留编号并清理前置依赖。旧库保持原位，不读取、迁移或删除，不创建替代插件。 |
| TASK-016 RDP/VNC 客户端 | 待前置闭合 | 两个插件宿主与前端、证书钉扎、剪贴板/输入、保留会话及特定按键辅助入口。 |
| TASK-017 RDP/VNC 服务端 | 待前置闭合 | 两个插件宿主、共享采集/公共库、系统权限和平台边界。 |
| TASK-018 Servers | 待前置闭合 | 配置迁移、服务生命周期、目录与原有功能等价。 |
| TASK-019 SocksCap | 待前置闭合 | 提权/驱动/辅助进程、文件与恢复日志、卸载清理迁出。 |
| TASK-020 截图 OCR/录制 | 待前置闭合 | OCR/录制插件；截图入口、滚动截图与采集保持核心归属。 |
| TASK-021 本地语音 | 待前置闭合 | 本地 ASR/FIM 引擎和模型插件；云 ASR/麦克风保持核心归属。 |
| TASK-022 Mobile | 待 M0 决策 | 按 DEC-2 默认暂缓排期；M0 末提供 go/no-go 与公开例外，不能默认为已交付。 |
| TASK-023 发布验收 | 部分 | 清单生成与上传顺序已有；四目标插件构建/系统签名、包签名、原子清单发布、独立插件更新/回滚、两套回归及性能。 |
| TASK-024 入口/profile 协同 | 随 005-A 已集成一部分 | GUI/headless bootstrap、ModeLease、可重试退出和任务回收已集成；跨宿主 profile lease、还原静默与完整多进程证据仍待完成。 |
| TASK-025 密钥/一致快照 | A–E 已集成；F/G 的三端 snapshot 契约通过，UI 待完成 | [服务、锁与快照实施方案](taomni-modular-vault-services-plan.md)；`4c060a939` 契约 #43844240041 已 23/23 成功，运行中 snapshot 三端各 4/4。三态真实重启还原的新用例待 hosted，原生确认自动 relaunch、独立 MFA 宿主及完整验收未完成。 |

具体编号与子任务边界仍以设计原表为准；上表合并描述不改变范围或依赖。

## 当前开发批次（`0f4cdf82f` 已提交，hosted 验证中）

- 验签路径采用与核心 updater 相同的固定公钥，校验真实 Minisign 签名、清单 sequence/内容、平台/版本/API、包 SHA-256 与内部精确文件清单。任意目录安装入口拒绝，版本目录保存签名原包供扫描、启用、启动、回滚和自动重启重新认证。离线安装入口已接入设置页；官方签名包的成功 UI 安装尚缺真实 artifact 验证。
- 安装失败恢复旧 active 指针和 registry 投影；卸载后普通安装也拒绝降级。前端 URL 包含不可变版本，逐资源返回经过签名文件 hash 核验的实际字节；实际业务 tab 的动态插件路由仍未完成。
- 生产宿主接入主动心跳、预算重启、请求 ID、稳定 RPC 错误与取消、退出清理。Windows 使用 Job Object；Linux 使用稳定 spawn-owner、PDEATHSIG 和 ownership guardian；macOS 使用 kqueue guardian。Unix 官方宿主及子孙须留在所属 session/process group，不允许 daemonize 逃逸；本方案不构成第三方沙箱。多进程 profile/备份静默仍属 TASK-024。
- 旧的伪版本 staging/active 迁移执行器已限制到测试编译；生产只保留安全 pending。
- `QA Modular Upgrade Contracts` 扩展为三端真实宿主生命周期/核心强杀清理、四发布目标采集库检查及 Linux X11 原生源测试。这些测试仍不证明已安装 0.5.x 的真实升级、系统签名信任、TCC、noexec、吞吐或 profile gates 已通过。

安装保留一份压缩原包作为可重验凭据，会增加数据目录空间占用。大于 32 MiB 的包必须使用 Minisign ED 预哈希签名；单个前端资源读取上限 256 MiB。Catalog 发布中断时不降低安全水位，重新获取同一或更高序号的签名清单可恢复安装。上述约束应纳入最终包构建、空间预检和发布演练。

`0f4cdf82f` 最终本地 Rust 受影响单元 139 passed（plugin 85、host 14、screenshot 11、MFA 13、mobile 6、RDP display 10），fmt、完整 QA audit 与 check:refactor 通过。此前模块/设置/离线安装前端 55 passed、URL loader 14 passed；采集库 21 passed，3 个真实 X11 测试仅 hosted opt-in。TASK-004 集成后的新增公共库和边界检查结果单列在下方，不混计为旧批次证据。

[QA Modular Upgrade Contracts #43774556826](https://github.com/engcapa/taomni/actions/runs/43774556826) 已全部通过，并取得执行期间下载的三平台宿主 artifacts：每端 14 项 unit 与 7 项真实进程测试通过。四个 capture 发布目标 check 通过；Windows 12、macOS 18、Linux 21 项库 unit 通过，Linux 另有 3 项真实 X11 测试通过，Linux 核心 plugin 单元 85 项通过。原始 artifacts 位于 `qa-ui-auto-report/github/43774556826/upgrade-live/`，完整 run 身份与日志位于同目录上级的 `run-final.json` / `workflow.log`。该 run 不包含之后新增的 RDP 公共库、Vault 基础库或官方签名成功链。

[QA UI Auto Platforms #43774557089](https://github.com/engcapa/taomni/actions/runs/43774557089) 已结束，22 个预期 shard artifact 均在执行期间采集，包含两个只有环境失败信息的 Wayland artifact。三端 browser 的 `TC-MODULES-006` 在关闭 Settings 后等待卸载时失败，属于本批相关问题，不能忽略；Linux Xvfb、Wayland 与 Windows native 也在同一步失败，macOS native 此 case 已通过。trace 显示 close 图标的 mousedown 冒泡先激活 tab，侧栏布局恢复后移动目标，使随后 click 未关闭。`54f7735c7` 阻止该冒泡并补完整指针手势单元回归；相关 15 项 Vitest 和 check:refactor 通过，case 仍断言真正移除 tab/panel 后重开恢复错误，待新 SHA hosted 重跑。

该源码 `0f4cdf82f` 的实际结果如下，不能移用为后续集成提交的通过证据；artifact 采集成功也不等于用例通过。

| 执行组 | 通过 / 已执行 | 失败或缺口 |
|---|---|---|
| Linux / Windows / macOS browser | 每端 32 / 33 | 每端 TC-MODULES-006。 |
| Linux Xvfb native | 39 / 40 | TC-MODULES-006。 |
| Windows native | 39 / 41 | TC-MODULES-006 与 RDP 重启用例的重复弹窗预期。 |
| macOS native | 39 / 39 | 本轮所选用例全部通过。 |
| Ubuntu 26.04 Wayland native | 18 / 20 | TC-MODULES-006 与既有 AI 路径 chip 命中；另 20 项因两个 shard 的环境安装失败未执行。 |

同 run 的两个 Ubuntu 26.04 Wayland shard 在 Playwright 1.55 安装 Chromium 依赖时失败，尚未执行 case，不能计为产品用例通过。workflow 已增加该 profile 专用的 `ubuntu24.04-x64` Playwright 平台覆盖，复用上游 Noble 构建与依赖清单；实际 desktop/profile 仍为 Ubuntu 26.04 Wayland。修复需在新 SHA 的 GitHub runner 验证，不能靠本地 shell 单元判断兼容性已通过。

执行期间下载的 Windows native shard 3 还发现新增 `TC-RDPS-NAT-01` 重启步骤错误地再次要求选择弹窗。生产 `systemRdpChoice.ts` 明确保留第一次的 Taomni 选择，首次真实 NLA/画面/输入、错误密码与停止后的拒绝连接均已通过，失败只发生在第二次等待弹窗。用例已改成断言不重复弹窗，并保留重启后真实客户端完整画面、第二次停止和拒绝连接断言；相关选择逻辑 7 项单元通过，新 SHA native 待重跑。

Wayland `TC-FILE-OPEN-008` 在已有 AI 路径 chip 点击处失败：失败截图显示长 inline 路径跨行，native hit-test 使用其外包矩形中心落在非命中位置。该 hook `src/components/chat/useChatFileLinks.ts` 与 main 相同，失败发生于既有 AI 入口，与这批模块化/采集实现无关。按用户指示单列保留原始失败，不计为通过、不放宽断言；后续相同输入仍失败时继续报告，不能用其他平台通过覆盖该记录。

最新集成批次：`2ed37513d` 为 C 准入/真实 Vault adapter；`be3479313` / `41c1c6f42` 为下载可靠性、真实网络 gate 与退出取消等待；`5b24d9874` / `fca580794` / `af8874a33` 为 CoreState、统一启动退出、可逆静默及 renderer 取消时仍完成已提交的退出。合并后的 `pnpm check:refactor` 已通过；上述生产行为仍需关联最终源码的新 hosted 证据。

本批 host pump 仅将现有收包/心跳/取消方法提取到 `host/pump.rs`，由既有 host 单元和真实进程 gate 保护；尚未处理 host→core 服务请求，不代表 TASK-025-D 已完成。C adapter 通过真实模块声明接入核心后，其专用四项单元及三端下载网络、生命周期单元已加入 upgrade workflow。

合并后的本地验证：前端模块/IPC/重启/Tab 50 项、系统 RDP 选择 7 项、API/作用域服务/下载 48 项、真实 Vault adapter 4 项、核心生命周期 18 项、宿主 14 项、runner 配置 6 项均通过；下载原有三个真实网络测试仍 ignored，新增网络用例留在 GitHub 执行。TypeScript、完整 QA audit、check:refactor、rustfmt、actionlint 与 diff 检查通过。新静态选择包含 68 个明确 case 与完整 crash-regression 的并集，22 个 shard、三套 release QA 构建，`gaps=[]`；这是计划，不是执行通过。Linux 核心单元 workflow 改为编译一次真实 harness、逐过滤器检查非空选择并保存日志及源码/二进制身份，避免重复完整编译。

## 接下来的执行顺序

### 当前待办（按依赖顺序）

已完成 retained locator、离线 v2 备份/还原、宿主自持 ProfileUseLease/PluginDataLease 和运行中 prepare/snapshot/release。`4c060a939` 契约三端快照通过；真实 UI 仍逐 shard 收证。三态 apply 已有原数据/代际/激活的独立观察，解锁顺序失败须新源码复验。已有证据只绑定实际输入，无关失败保留原始记录并不计通过。

1. **收敛当前相关失败并取得新源码证据**：三端 MFA 原型 5+2 个场景和 Linux 真实 Vault 3 项已由 `2975f3401` 通过，四目标签名包已产出；先提交并复验三端正式安装门的环境修复，补齐每端 3 项实际安装/Vault 场景。Linux Xvfb/Windows 的三态还原和 fixture 清理已通过，继续收取 macOS。动态前端批次单元/静态检查及 case 元数据已齐，提交后以新签名 hello 包执行 TC-MODULES-016/017/018、受影响 MFA/还原/备份与完整 browser/native crash-regression；完成 shard 即下载，不等 summary。
2. **闭合 Vault、profile 与一致快照（TASK-024/025）**：完成 GUI/headless 同 profile 协同、运行/禁用/卸载保留数据三态正常重启 apply 与真实解密、多实例占用、取消和崩溃恢复；验证原生还原确认入口自动 relaunch 的接管。MFA 迁出时还需 v1 legacy alias 与独立宿主后的三态还原。
3. **迁出真实业务（TASK-005-B、013/014、016–022）**：先完成真实 MFA 宿主原型的匹配 runner 证据、可信签名安装、相关 G 门、旧库只读迁移与动态 UI，再切换生产 facade 和连接 owner。之后依赖序推进 RDP/VNC 客户端与服务端、Servers、SocksCap、OCR/录制、本地语音的宿主、前端、状态与迁移。Mobile 按 DEC-2 留下明确 go/no-go 结论和公开例外，不能默认为交付；LanChat 任务已取消，不新增替代插件。
4. **裁剪核心依赖闭包（TASK-006）**：随业务迁出，从核心 Cargo 默认 features、原生依赖、bundle/resources/helper 和前端 chunk 中实际移除相应实现。保存 cargo tree、资源与产物证据；把状态改名或放入 LegacyFeatureRuntime 不等于瘦身完成。
5. **完成模块使用闭环（TASK-007、009–011）**：远端签名商店、三种代理设置 UI、跨应用重启发现并恢复下载、后台进度及错误恢复；实际主窗/分离窗动态 tab、坏 hash/缺失/禁用占位和清理；安装、启用、禁用、更新、回滚无需重启核心。
6. **验证真实旧单体升级（TASK-012）**：从已发布、已安装的 0.5.x 取得真实数据，经 legacy exporter、可信包 staging、Vault 交接和原子激活；覆盖升级中断、失败、重试和回滚，并证明原数据未损坏。现有只读预检/pending journal 与合成 fixture 都不算该验收；旧 LanChat 库保持原位且不读取。
7. **完成生产发布验收（TASK-001/002/023）**：闭合 G1–G11、冻结真实插件契约；完成四发布目标的宿主系统签名/包签名、原子 modules 清单、模块独立更新/回滚。核心-only 与实际全插件集合分别完成受影响用例及完整 crash-regression，并归档包体积、启动、内存、帧吞吐的匹配基线与原始样本。

### 2026-11-16 启用与原生观察修复批次（`911f411b2` 已提交，hosted 验证中）

- 源码 `5d49b9abc` 的旧 UI run 已结束，22 个 shard 在运行期间收齐。三端 browser 各 24/24；Linux Xvfb、Windows、macOS native 各 27/29，相关失败均为 TC-MODULES-007 第 15 步真实 `enabled=false` 和 TC-MODULES-009 第 0 步 metadata 尚未 bootstrap。Wayland 为 25/29，另外两个既有 FILE-OPEN-008/006 失败按前述 main 对比依据单列，不计为通过。
- 修复以 `88f59ba79` / `911f411b2` 提交并推送；新[契约 #43800283024](https://github.com/engcapa/taomni/actions/runs/43800283024)和 [UI #43800287415](https://github.com/engcapa/taomni/actions/runs/43800287415) 已启动，两套即时采集器均工作。三端真实宿主日志已即时核验：每端 activation 3/3、cleanup 2/2、lifecycle 7/7、SDK 8/8；这不替代原生 UI 用例。
- 新契约的 macOS observation unit 暴露测试临时目录 `/var` 与 `/private/var` 的别名差异。已通过 job logs API 立即取回失败日志（不等整个 run 结束），修复测试使用 canonical root，产品探针的路径限制不放宽；workflow 新增三端失败也上传该单元日志。该工具修复仍需新 SHA hosted 重跑。
- 宿主首次启动和预算重启共用 `host/launch.rs`：认证握手后，只对可信 manifest 声明了 `plugin/enable` 的宿主调用启用钩子，并等成功才返回；握手与启用共享一个启动 deadline。未声明钩子的 v1 服务宿主保持兼容；不把 hello 的默认状态改成启用，也不放宽真实 identity 断言。新增 hello 首次启用与重启状态断言，另有拒绝、超时/实际进程回收、无钩子三个 hosted 场景；workflow 明确选择全部场景。本地只编译这些真实进程测试。
- generation fixture 改为首次启动前仅登记路径，在应用就绪后由 `assert_core_profile_generation` capture 真实 canonical UUID，正常重启后比较同一路径与值；禁止二次 capture 掩盖变化。不创建、不覆盖产品 metadata，独立保存观察 evidence，TC-MODULES-009 保持 24 步与原 checkpoint 索引。
- 正常重启失败时，在释放 driver 前以独立 3 秒预算保存 WebView screenshot、HTML 和关闭按钮的真实命中层；采证失败不替换原异常。这是为 Windows 旧 hit-test 失败补诊断，不代表问题已修复。
- 观察/重启/官方包工具 60 项纯单元通过；新源码核心精确过滤器 117 passed、3 个真实进程场景 ignored，小 crate services 28 / host 14 passed（host 与核心有重复，不混加）。真实 hosted 20 场景仅编译。两个原生用例 schema、reviewed contract 和 verb 注册、完整 QA audit（756 cases、0 errors、catalog current）、check:refactor、rustfmt、actionlint、diff 检查通过；三端静态选择为 22 shards、3 个 release QA 构建、gaps=[]。新的宿主行为、metadata 与退出凭据仍待匹配新源码的 GitHub runner 证据。

### 2026-11-16 核心操作与宿主退出凭据批次（开发中）

- 新增 `CoreOperationPermit`，使仍在核心的受保护业务与宿主共用 epoch/generation、限额、跨进程 lease 和排空计数；没有 HostInstance/wire context，不能借它执行 reverse RPC。核心业务调用方尚未接通，不能据此报告真实 MFA 已适配。
- `AuthorizedHost` 的克隆共享一次实例的终止标记；只有实际 transport 的内核进程树确认成功才记录。崩溃 transport 在 session 释放后仍保留对应身份与 dispatcher；历史 operation/敏感 frame 的 lease 仍要实际释放才能完成撤销。相同 revocation 的确认可重试，错误 epoch/generation/实例仍被拒绝。
- registry 的 scan、禁用、卸载、版本切换、静默和退出改为确认成功后才移除 runtime；失败保留所有权并返回错误，不提前删除数据或更新 active 指针。GUI 退出准备持有可逆静默屏障到提交，headless 也传播确认失败；这批行为待匹配新源码的 hosted native 证据。
- 当前纯进程内 services 单元 28 passed（新增核心操作 5 项、终止凭据 4 项）；生产 host 单元 14 passed，真实 SDK 场景只编译，未在本机执行。核心 registry/退出新增单元与最终静态检查已通过，详见上方启用修复批次。Vault init/unlock/lock/rekey coordinator、MFA 的外层 permit 和一致快照仍未接入。

### 2026-11-16 即时收取的相关失败与修复

- 修复源码 `5d49b9abca67ee5276839067f8e193f9a16ec83b` 的 [契约 #43793976461](https://github.com/engcapa/taomni/actions/runs/43793976461) 已 23/23 jobs 成功，21 份 artifact 在执行期间收齐；macOS 实际日志中的 17 项 unit、2 个 cleanup、6 个 lifecycle、8 个 SDK 场景全部通过。相同源码的 [UI #43794006016](https://github.com/engcapa/taomni/actions/runs/43794006016) 已即时收齐六个 browser shard，三端每端 24/24、identity stable；native 仍在构建/执行，不计为已通过。该证据不包含上述后续开发中的退出凭据批次。

- 源码 `00ac480d81522f3497b3d6804de389cfa77bf0ca` 的 [契约 #43791785215](https://github.com/engcapa/taomni/actions/runs/43791785215) 已结束，22/23 jobs 成功，21 份 artifacts 已在执行期间收齐。Linux/Windows 的 2 个 cleanup、6 个 lifecycle 和 8 个 SDK 真实进程场景均通过；macOS 的 cleanup 2/2、lifecycle 6/6、SDK 7/8。失败为 `confirmed_stop_keeps_crashed_transport_ownership_until_termination_is_observed`，终止查询返回 EPERM，不能忽略或伪造确认。
- Darwin 的负进程组信号探测会过滤僵尸成员，可能对仅余僵尸的组返回 EPERM（XNU `bsd/kern/kern_sig.c` 的 `killpg1`）。修复改为 libproc 枚举所属组并检查每个成员的当前 group/status；只有没有存活成员才确认，查询权限/截断/不完整返回仍失败。真实进程回归沿用上述已失败场景与子孙树退出场景，新增三项纯状态判断单元；macOS 实际结果仍待新 SHA hosted 执行。
- [UI #43787465425](https://github.com/engcapa/taomni/actions/runs/43787465425) 的 macOS native shard 2/4 已边运行边下载。shard 4 为 13/13；shard 2 为 11/12，TC-MODULES-007 在第 12 步失败，其余包括真实 RDP loopback、性能与 crash 场景通过。原生 registry 确实为 `installed`；用例本来就断言未启用调用返回 InvalidState，但观察结果根对象含 `error`，被 W3C transport 误认成驱动失败。新单元已用真实 transport decoder、模拟响应复现相同异常；修复仅包裹观察值，不放宽拒绝断言或启用后的真实 host identity。重跑前不计该 case 通过，其余 shard 继续执行。
- 该旧 run 已结束，22 个 shard artifact 全部收齐。macOS 四个 native shard 为 47/48，Linux Xvfb 为 47/48，两端唯一失败均为同一 TC-MODULES-007 探针；Windows native 为 48/50，另有 TC-MODULES-009 关闭前的指针 hit-test 失败，尚待排查，不能忽略。按最终逐 case summary 复核，Wayland 为 44/48：同一探针、既有 TC-FILE-OPEN-008 路径 chip 命中问题，以及 TC-FILE-OPEN-006 的非左键输入需要 X11、TC-MOBILE-021 的 OS 文本输入仅到达 `77` 而缺少 `QA_DESK_`。后两项原生指针工具和 `deliver_keyboard_input`/probe 路径均与 main 相同；Mobile 真实屏幕 PNG、权限开关与浏览器打开已通过，失败发生在未改动的 Enigo 文本输入。按用户指示把这些 Wayland 工具/输入缺口单列，不改断言、不记通过，不阻塞本批模块化修复。
- 本批本地纯单元：Python 原生观察/官方包契约 9 passed，宿主既有 unit 14 passed；完整 QA audit、check:refactor、rustfmt、actionlint、diff 检查及模块场景加完整 crash-regression 的三端静态选择通过（22 shards）。macOS 新 kernel 状态判断的三个 unit 和真实进程/native case 留在 GitHub 执行，静态选择不算执行证据。

### 2026-11-16 生产工厂与 profile generation 批次

- 双向服务源码 `4a67992d6f5f05e1644888aac8371a9dbcb4c479` 的 [升级契约 #43787463856](https://github.com/engcapa/taomni/actions/runs/43787463856) 已 23/23 jobs 成功，21 份 artifact 在执行期间下载。实际日志复核：三端每端 7 个既有宿主进程场景、6 个 SDK 双向 stdio 场景通过；Linux 两个真实 Vault/SDK 场景通过，receipt 绑定该源码及 core/SDK 二进制 hash。原始结果见 `qa-ui-auto-report/github/43787463856/live-contracts/`；仍不属于已安装 MFA 业务迁移证据。
- 相同源码的 [UI Platforms #43787465425](https://github.com/engcapa/taomni/actions/runs/43787465425) 已即时下载六个 browser shard：Linux/Windows/macOS 每端 35/35，无 fail/skip，identity stable。Windows 官方包签名链通过，确认 LF 修复；三端 native 仍在构建/执行，不能计为通过。
- 本批生产 registry 由统一 GUI/headless bootstrap 配置 `PluginCoreServices`，真实 Vault 作为独立 backend。host factory 只使用 `host_location` 刚验签的 manifest；安装/扫描/启动共用固定 key owner policy。没有核心服务声明的 hello 继续使用旧 wire。dispatcher 在宿主停止且 registry/lifecycle mutex 释放后关闭并 join，不反持 AppState/registry。
- `dispatch.rs` 单独承担 renderer correlation 与 core-only scoped invoke。renderer 的 request ID 仍不能带方向前缀，内部 operation class/context 不接受 renderer 参数；核心在宿主 mutex 前获取外层 VaultOperationLease。取消表保存真实 wire target，排队前取消、取消与 attachment 竞态、shutdown 均映射到 scoped request，drop 清理两者。
- `.profile-state.json` 用稳定 `.profile-locks/profile-state.lock` 协调创建、读取和原子替换。普通重启保留 generation；还原应用前换新 generation 并写 journal，旧 journal 缺字段时补齐，恢复/回滚不使用旧归档 generation。Unix 同步父目录，Windows 沿用已同步临时文件的原子替换且不外推同等 directory fsync。损坏或 symlink state 拒绝启动/写入，不静默重新生成。
- 新增显式 `revoke_keys(deadline)` 和 `stop_confirmed(deadline)`：Linux 核验实际进程组中的存活进程（僵尸不持地址空间），Windows 核验 Job Object ActiveProcesses，macOS 等待所属进程组退出。崩溃 transport 保留 ownership 到确认，不在失去 receipt 后假称清理完成；替换宿主前先确认旧 transport 终止。两个新 SDK 终止场景只在 hosted 执行，SDK selection 从 6 增至 8。
- `TC-MODULES-009` 新增真实 `.profile-state.json` 在正常重启前后的同值断言。fixture 只读 run-owned profile，验证 canonical UUID 后提供路径和值，不生成/覆盖 metadata；browser 保留 TC-MODULES-008/001/006，真实 host/network 边界继续由 hosted gates 和 native case 保护。
- 本批本地只执行纯单元/静态/编译：核心精确过滤器 110 passed、3 个真实进程场景 ignored；小 crate host 14/profile 锁 7 passed（host 断言与核心有重复，不混加为独立场景），QA fixture 单元 2 passed。新增真实 SDK 8 项和进程树 cleanup 2 项仅编译，不在本机执行。完整 QA audit、TC-MODULES-009 三端静态选择、check:refactor、rustfmt、actionlint 和 diff 检查通过。
- 这一批**尚未把 Vault init/unlock/lock/change-master IPC 接入 admission 状态转换**，服务准入在 bootstrap 默认关闭，真实 MFA facade 也未调用 scoped 入口。因此不能把 factory、SDK 或 metadata 的接线报告为 TASK-025-D/E 完成，更不能报告业务已迁出。后续须统一关闭准入、撤销/确认退出、drain、清 root，保留历史 transport 的确认记录，并让真实 MFA 操作领取作用域/密码导出/reset grant。

### 2026-11-16 双向服务批次与最新 runner 证据

- [升级契约 #43781962402](https://github.com/engcapa/taomni/actions/runs/43781962402)，源码 `038b539a413ec44b248f3eb25801c0407c067bc1`，23/23 jobs 成功。21 份 artifact 均在执行期间下载到 `qa-ui-auto-report/github/43781962402/live-contracts/`，已复核实际日志：三端每端 13 个真实下载场景、7 个宿主真实进程场景、1 个 profile/插件写锁崩溃释放场景通过；四目标 capture/RDP 编译、三端公共库单元和 Linux 真实 Vault 4 项/核心生命周期精确过滤器通过。这一 run 尚未包含下面新增的 D 实现。
- [UI Platforms #43782128064](https://github.com/engcapa/taomni/actions/runs/43782128064)，相同源码，六个 browser shard 已即时采集；Linux/Windows/macOS 每端 35/35，无 case fail/skip。Windows 官方包在签名前拒绝前端字节差异：可信文件 95 bytes/0 CRLF，Windows artifact 99 bytes/4 CRLF，且仅将 CRLF 换为 LF 后逐字节相同。`.gitattributes` 已对该官方前端固定 LF，签名器的严格 `read_bytes()` 比较不放宽。该依赖失败会阻断所有 native jobs，因此结束该轮无法进入 native 的执行，待修复和 D 批次新 SHA 重跑；native 用例未执行，不计通过。
- 新实现：`RpcRequest.context`、握手 `coreServices`/`hostInstance` 为 v1 可选加法，旧 params 和 hello 保持不变。`CoreServiceDispatcher` 默认 2 workers/16 queued，session 最多 8 个请求，校验方向 ID、已认证实例、context、deadline、owner/manifest 和 replay。`SensitiveServiceFrame` 原样进入 writer 队列，dequeue 重新验证并持有 permit 到 flush/drop。active、idle、cancel grace 使用同一 pump。
- 新 `taomni-plugin-sdk` 的独立读循环持续响应心跳、取消和 revoke，业务 worker 等待 typed key reply；raw JSON 直接解析为 `FixedKeyResult`，在交付业务 worker 前清零原帧和已消费的 read scratch。密钥 guard 绑定 operation，成功/失败/panic/cancel 清理；不经过通用 Value。核心真实 Vault 已实现 backend trait，仍保持旧固定 ID、缺 key/损坏语义和仅显式初始化/重置可写。
- 本批 API 16、services 19、SDK 7、host 14，共 56 项进程内纯单元通过。新增 6 个 `taomni-host-gates/tests/services.rs` 场景及 2 个根 `vault::plugin_access::host_tests` 场景只编译、不在本机执行；workflow 已接三端 SDK stdio、慢 reverse 时心跳/独立 deadline、取消、实例替换、revoke/新 epoch 和 renderer 不可扩权，以及 Linux 真实旧 key/空库初始化。它们不是已安装/签名 MFA 插件的升级证据。
- 本批没有新增用户入口，复用 TC-MODULES-001/006/007/008/009 与完整 crash-regression 保护既有启动、安装、宿主和退出行为；新增协议边界由上述 hosted 原生进程场景验证。真实 MFA UI 迁出仍须注册/执行计划的 TC-MODULES-020–025，不能用 fixture 代替。
- D 尚需从 verified registry/bootstrap 构造生产 services factory、在 host mutex 前取得外层 permit，并与真实 Vault lock/unlock/rekey、profile generation 和任务退出统一协调；之后再推进 E–I。当前 SDK fixture 不是第二个已交付业务插件。

当前顺序以上方“当前待办”为准。远程 main 已在上一轮拉取并纳入当前分支；历史成功只绑定其各自输入，不替代后续源码验证。

## 验收闭合条件

| 验收 | 当前剩余边界 |
|---|---|
| AC-001/010 | 核心瘦身和 10 个有效插件功能等价，只有 DEC-2 明示例外。 |
| AC-002/005 | 实际 tab 动态加载、缺失占位和保留会话可编辑/导入。 |
| AC-003 | 三代理、取消/续传、后台恢复要在完整商店与原生网络边界验证。 |
| AC-004/007 | 生产监督、稳定错误码、取消、进程树回收及运行中生命周期。 |
| AC-006/017 | 真实已安装 0.5.x → 模块化，数据/Vault 一致与失败恢复。 |
| AC-008/009 | 签名、内容绑定、防降级、安全解包及原子发布，单插件可独立更新。 |
| AC-011/015/016 | 多进程静默/profile 协同、作用域密钥和一致备份恢复。 |
| AC-012/013/014 | 四发布目标、多端功能/crash/性能、核心版和完整插件版的最终证据。 |

G1–G11 均待完整原生实验闭合，不能以纯单测替代。V-001–V-012 按上述实现批次补齐，已有验证只保护其实际输入与断言。

## 最近已完成的验证

以下记录针对源码 `2a245d52d07680d76a3cfd1f4240a484d2598ed7`，后续改动需重新选择受影响验证。

- [QA UI Auto Platforms #43732808941](https://github.com/engcapa/taomni/actions/runs/43732808941)：Linux、Windows、macOS 的 browser 各 22/22、native 各 25/25；包含 TC-MODULES-001–005 和完整 crash-regression。18 个预期 shard 均已在执行期间采集，无失败、skip、缺失或环境阻塞。
- [QA Modular Upgrade Contracts #43737735365](https://github.com/engcapa/taomni/actions/runs/43737735365)：Ubuntu、Windows、macOS 均通过。这是契约/单元测试工作流，尚不证明真实安装升级。
- 本地近期迁移单元测试 10/10、Settings/ModuleStore 29/29；TypeScript、rustfmt 和 refactor boundary 检查通过。更早 Rust lib 全量结果不能代替新改动后的验证。

原始 artifact 下载到 gitignored 的 `qa-ui-auto-report/github/<run-id>/`；当前 run 的完整 shard 索引位于 `43732808941/live-shards-final/live-shard-index.json`，summary/selection 位于同 run 的 `summary-final/`。最终证据要关联实际源码 SHA、case、平台和构建身份。

本地只跑单元测试与静态检查；browser/native、跨进程及真实安装升级在 GitHub runner 执行。每轮包含受影响 case 与完整 crash-regression，运行期间立即采集已完成 shard。与本次修改无关且有依据的既有失败可以单列忽略；本次引入的失败必须修复重跑。


## TASK-003 采集下沉测试设计与证据

本批保持设计 §4.2.1 的六项行为约束：Linux capture 库不引入 xcap；macOS 静态/录制继续用一次性快照而 RDP 保留 SCK/显示流；Wayland ScreenCast、指定显示器流和 MFA Screenshot portal 保持不同授权流程；BGRA/stride/帧时间戳及 MFA TQF1/灰度顺序不变；窗口隐藏、取消和源回收可重入。截图日志改为核心 `taomni::capture`，真正 RDP 流仍由服务器注入日志；已检索现有 YAML/Vitest，没有依赖旧截图 RDP 日志的断言。

改前依据为 `2a245d52d07680d76a3cfd1f4240a484d2598ed7` 的生产实现与既有用例。该 SHA 的历史模块/crash 测试通过不能当作这批真实采集的改前运行基线；本批特定 still/record/scroll/MFA/Mobile/RDP 改前性能比较尚无同条件原始样本。以下新增步骤全部追加，保留原有像素、错误分支、延迟和吞吐预算，不放宽失败条件。`0f4cdf82f` 的 browser/native 正在执行，已取得的部分 case 与采集契约证据见上方 run 记录，尚无完整 UI/crash 通过结论。本地采集边界测试 4/4、边界 CLI、9 个修改 case 的 schema/behavior contract、完整 `qa_ui_auto.audit --gate` 与 `git diff --check` 通过。静态 selected plan 已验证 25 个目标/保留 case 加 crash-regression、三端 browser/native 与 Linux Xvfb/Wayland、release native 共 22 个预期 shard，`gaps=[]`；当时的未提交 plan 不能当运行证据，实际运行必须关联最终源码身份与新 selection。

| AC / V | 场景与保留合同 | 用例、步骤和预期结果 | 层 / fixture / native 原因 |
|---|---|---|---|
| AC-001/010；V-003 | 核心截图取消再开，保留同一个终端 | 更新 `TC-104`：既有按钮取消后重开当前窗口截图，仍为未选区状态；Escape 后 overlay 消失且仅一个原终端 pane，运行时无错。 | browser、`reset_db`；只证明 renderer 与 stub 分发，真实窗口由 N28/N30 保护。 |
| AC-010/012；V-003 | MFA 核心服务错误恢复与二维码数据保持 | 更新 `TC-MFA-007`：浏览器 desktop-only 失败后重开重试，仍能退出且原 HOTP 不变。更新 `TC-MFA-106`：真实成功导入→关闭外部 QR→no-QR→恢复外部 QR 再扫，duplicate-only review 禁止导入；Escape 恢复后仍只有原账户和 755 224。 | browser fake camera 与 native `reset_db`；106 的独立 topmost QR 和真实像素/隐藏恢复仅 Linux X11/Wayland、Windows，macOS MFA TCC 仍需单独证据。106 保留 `TC-BACKUP-AUTH-715` 的授权浏览器清扫前置边。 |
| AC-001/010；V-003 | Mobile 显示器切换、后台刷新和真实核心采集 | 更新 `TC-MOBILE-020`：从副屏关自动刷新、切回主屏、手动刷新，receipt 与已加载 PNG 对应主屏。更新 `TC-MOBILE-021`：保留真实 opt-in 403→开启、两次 PNG、独立 OS input/嵌入 Mobile Web 检查，新增 receipt 的 display/window/event 数量门。 | 020 browser `mobile_web` 仅模拟 HTTP；021 native `reset_db,mobile_service` 验证真实 IPC、OS 采集/输入，仅 Linux/Windows，macOS/Wayland 限制不变。 |
| AC-010/012；V-003 | 录制源释放后仍可截图 | 更新 `TC-SHOT-N5/N6`：原 GIF/MP4 每帧像素、nonce、时间轴/覆盖率全保留；随后立即执行真实 still，留非空图与尺寸并恢复主窗口。 | 三端 native `reset_db`；browser 不能证明编码器、系统资源或真实像素，N5/N6 共用对应 QA app 的构建。 |
| AC-010/012；V-003 | macOS 输入权限失败不污染采集权限 | 更新 `TC-SHOT-N15`：原自动滚动 Accessibility 拒绝持久错误与双出口全保留，随后真实 still 成功并恢复主窗口。 | macOS native `reset_db`；拒绝只注入隔离 QA 边界，不修改 TCC，Screen Recording 正常 grant 仍是 fixture 前置。 |
| AC-004/010/013；V-003 | RDP stop/restart 回收与帧合同 | 更新实际 ID `TC-RDPS-NAT-01-start-connect-display`：原认证/输入/拒绝/停止后再 Start，独立 probe 再收到图像且 painted_share≥0.95，第二 Stop 后连接拒绝。保留 `TC-RDPS-PERF-01-performance-budget` 的 M1≤500ms、M2 p95≤65ms、M3≥25.6fps、M4≤4905kbps。 | 三端 native；真实 NLA、OS source、输入和外部 probe。PERF 要 `release_build_required` 和同条件基线；不能用 debug build 或单次绿结果替代性能比较。 |
| AC-001/010；V-003 | 依赖闭包与数据格式 | `scripts/modular-boundaries.mjs` 拒绝 screenshot/MFA/mobile 的 Servers 耦合，唯一精确例外是 `mobile/headless.rs` 建表；拒绝 library 的 Tauri/Wry/core dependency 和非 macOS/Windows 的 xcap。`taomni-capture::pixels::tests` 检查 stride/Bytes clone/灰度顺序与透明合成、短帧/溢出；原引擎/权限/取消 unit 保留。 | 本地 unit/static；GitHub Linux `cargo tree -p taomni-capture --target x86_64-unknown-linux-gnu --edges normal,build,dev` 的输出交 `node scripts/modular-boundaries.mjs --linux-tree <path>`，拒绝 transitive xcap/Tauri/Wry。 |

本批最小选择是上述目标和保留行为的去重并集，额外包含：`TC-SHOT-N1`（真实 still/OCR/clipboard）、`TC-SHOT-N2/N9/N16/N22`（自动/手动/重复滚动、停止输入与完整像素）、`TC-SHOT-N27/N28/N30`（启动计时、真实窗口隐藏隔离、resident 源生命周期）；browser 保留 `TC-SHOT-003/008/020/027/029/030/031`（滚动预览与导出、录制取消/保存、权限错误/手动模式）。还必须加入完整 `crash-regression` tag。使用现有 policy 已注册 ID，不新增用例编号；依赖表为新增生命周期断言补显式无前置条目，不依赖旧 case 的隐含进程状态。

GitHub 另外在 Xvfb 的真实 X11 display 上 opt-in 执行 `cargo test --manifest-path src-tauri/Cargo.toml -p taomni-capture --lib -- --ignored` 的 3 个源测试。它们现在要求 DISPLAY、MIT-SHM/XDamage fixture 真正可用，缺失即失败；普通本地 unit 不触屏且不会把无 display 的早退计为 native 成功。`43774556826` 已通过四目标 check、各 runner 架构 unit、Linux tree 与 3 项真实 X11 测试并下载 artifacts；对应 UI/native case 仍随 `43774557089` 执行，按已完成 shard 即时下载。

局限继续显式保留：`capture.still` 大帧 RPC 尚未接入；macOS MFA 屏幕录制归属、Linux Wayland 三授权流程和 RDP 性能需要对应真实 runner；本地 schema/audit、较小文件或成功编译均不证明这些行为等价。

## TASK-004 RDP 公共库边界与保留行为

改前材料是 `2a245d52d` 的客户端/服务端实现；集成基础为已包含远程 main 修复及 host/capture 的 `0f4cdf82f`。`taomni-rdp-common` 负责 CLIPRDR 编解码、CF_HTML/DIB/DIBV5 与策略值、7 个有界文件操作 helper，以及可选 `bitmap` 能力协商。`taomni-file-uri` 仅以标准库提供既有宽容 URI-list 编解码，核心 `config::paths` 直接依赖它，关闭 RDP 业务也不必引入协议依赖。RDP 旧 facade 保留兼容导出；服务端和 loopback 测试直接用共享库，不再调用客户端实现。bitmap 使用同一个 `ironrdp-pdu 0.9.0`，QOI/QOIZ 与原客户端解码 feature 一起保留。

配额、请求/stream 关联、取消、staging 的 Drop/Once 清理、延迟剪贴板发布和 session 生命周期仍归原客户端/服务端持有。逐函数复核确认 7 个文件 helper、URI、CLIPRDR 与 HTML/DIB 的原逻辑和错误文本保持不变。单元补足 UTF-16 长度、路径穿越/盘符/ADS、偏移读写与 16 MiB 上限、私有目录、Unix 符号链接不修改目标、Unicode/非法百分号 URI 和 bitmap offer。新文件最大 427 行，测试按协议/格式/文件行为独立拆分。

本任务只改变实现归属与依赖，没有新增 UI 流程或改变协议/持久化，所以复用下列已注册、已断言真实结果的用例，不新增仅断言内部模块名或重复现有步骤的 YAML。完整 ID 与模式如下；这是目标和受影响保留行为的去重集合，不是已通过的执行结果。

| AC / V 与保留行为 | 已有用例及真实断言 | 执行边界 |
|---|---|---|
| AC-009/010；V-003：产品客户端/服务端能力配对 | `TC-RDPJ-01-client-server-loopback`：真实客户端显示宿主桌面、点击改变独立宿主 target、全屏连接栏与断开后服务端再次接受 probe。 | 三端 native；browser 不含 IronRDP 会话解码/OS 输入，独立 probe 不能代替产品双方配对。 |
| AC-010/012；V-003：富格式与图像编解码 | `TC-RDPS-NAT-02-clipboard-rich`：真实主机剪贴板与外部 CLIPRDR probe 的 Unicode、HTML 和图像双向传输，保留原格式/内容断言。 | 三端 native，真实 OS 剪贴板；不由 stub 成功替代。 |
| AC-010/012；V-003：文件路径、内容和 staging 发布 | `TC-RDPS-NAT-03-clipboard-files`：双向 Unicode 多层目录，主机发布的 staging 树与客户端下载的每个相对路径和 SHA-256 相同。 | 三端 native，真实文件与剪贴板；安全拒绝/大小上限的组合由共享库 unit 另行覆盖。 |
| AC-010/012；V-003：策略依旧限制两个方向 | `TC-RDPS-NAT-09-clipboard-policy`：text-only 不发布 HTML/图像/文件，禁用反向后不请求客户端数据且主机剪贴板不变。 | 三端 native；UI 保存本身不证明策略执行。 |
| AC-010/012；V-003：同机双方没有回声 | `TC-RDPJ-02-joint-clipboard-no-echo`：产品双方同机、主机内容正确、日志计数与 quiet period 保留，断开后服务仍可用。 | 三端 native，真实共享系统剪贴板和变更计数。 |
| AC-010/012；V-003：延迟发布仍只转发一次 | `TC-RDPJ-03-deferred-clipboard-publication`：macOS AppKit 先声明类型、1.2 秒后同 token 发布文本，保留内容、公告次数、六秒静默与退出断言。 | macOS native 专项；其他平台按现有 capability/policy 选择，不能计为已执行。 |
| AC-010；V-003：配置控件与持久化保持 | `TC-RDPS-UI-03-rdp-media-clipboard-settings`：默认值、双向策略、文件限制条件显示、Apply 后重开恢复。 | **仅 browser**；该 case 未声明 native，原生策略证据由 NAT-09 提供。 |

六个 native case 为 RDPJ-01/02/03 与 NAT-02/03/09；browser 额外是 UI-03。按平台能力执行实际子集，不把 macOS 专项扩报为三端通过。下一次 `qa-ui-auto-platforms` selection 与 TASK-003 的 NAT-01/性能、模块场景和完整 `crash-regression` 取去重并集；平台 workflow 原有 RDP/dual-display contract 继续开启，不再在升级 workflow 重复全量 RDP。

基于 `0f4cdf82f` 的 Linux 本地集成验证已完成：`cargo metadata --locked`，两库 `--all-features` 39/39、common `--no-default-features` 30/30、模块边界脚本 6/6、`pnpm check:refactor`（799 命令、274 facade exports、29 events）均通过；这不是其他平台或真实 UI/剪贴板证据。Windows 不编译 Unix symlink 测试，预期数量相应少一项。common 的 minimal normal/build tree 仅自身、`libc` 和 URI 库，URI tree 仅自身；静态门禁止 servers/config 导入客户端、共享库导入核心/Tauri/Wry，以及 URI 库增加 runtime/build 依赖。

`qa-modular-upgrade.yml` 新增四发布目标 shared-library `cargo check --all-targets --all-features`、三个 runner 架构的完整/minimal 纯 unit 和严格 normal/build tree allowlist。原 host/capture job 保留；Linux 升级 job 仅追加 `rdp::session::tests::input_and_channels`、`servers::rdp::clipboard::tests`、`config::tests` 三组原调用方单元过滤。日志分别归档为 `modular-rdp-check-*`、`modular-rdp-unit-*`、`modular-retained-rdp-core-linux`。本提交的这些 hosted job 与上表 UI/native 尚待执行，不能用 `0f4cdf82f` 或 `2a245d52d` 的成功代替。
