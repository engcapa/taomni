# 工作区文件打开与 SDK 后台初始化

**2026-10-30 持续开发、测试与验证；性能及三平台验收仍未通过。** 当前进展见下方“本轮恢复记录”；其后的暂停快照及历史结果保留用于追溯，不能视作当前组合源码已验收。

## 本轮恢复记录（持续更新）

- `2fb88b24723d654e70478ee4398f68af4af41443` 的 GitHub [41012953201](https://github.com/engcapa/taomni/actions/runs/41012953201) 在计划前的crash-regression契约测试失败，尚未执行UI用例。原因是新增Code Style崩溃用例后，固定崩溃名单和smoke名单未同步；本轮补齐两处，并明确该新增用例的browser范围，保留三平台native原有全部崩溃用例及实际失败门禁。这是测试契约补齐，不改变产品源码、测量脚本或性能阈值；原始失败保留。
- `bc75d8567926520038c66177aa1a45ada4557549` 的 GitHub [41007654861](https://github.com/engcapa/taomni/actions/runs/41007654861) 已收齐并核验273次执行、18份回执及6508个附件：**270 passed / 3 failed / 0 skipped**，与完整75 ID的selection一致，无能力缺口。三平台browser各45/45、Windows native45/45；Linux native45/47，074/075长帧分别165.00000000000364/173ms，保持原始失败；macOS native45/46，TREE-01在分屏容器出现后立即读到1个编辑器。失败捕获随后已有两个实际EditorView和原文件正文，现仅为此用例增加第二pane的内容就绪条件，保留恰好2个编辑器的原断言并补第二pane正文与运行时错误断言，不放宽性能预算。072重载和074树指针功能在三平台均通过，SDK061–063、macOS原生菜单080和完整适用crash组通过。本机matching release native23/25，070/073分别206/171ms失败；标准browser21/22，070为241ms；回执、附件和source/runner/release均已核验，不能称作性能验收通过。
- 本机070的CPU采样显示关闭的导航/编辑弹层、SDK状态和固定键位构造仍参与同步提交。本轮让关闭的弹层组跳过无关props更新，并只在Search Everywhere或Keymap实际消费动作时订阅projection；打开/关闭仍完整渲染、清理和恢复焦点，重开读取当前owner、文件、动作和handler。SDK状态保留自身请求及语言订阅；固定CodeMirror primitive keymap仅懒构造一次，动态host派发仍逐实例绑定。关闭订阅回归修前3项失败，修后与当前动作、StrictMode、文档焦点、迟到LSP消息、右键菜单、剪贴板和Go To Line等支持组合9文件60项通过；实际性能收益仍待无诊断browser/native与GitHub验证。
- 上述挂载回归另稳定复现Code Style设置在关闭→打开时因条件返回前后Hooks数量不同而崩溃；真实browser从Actions入口也已改前失败，原件为`workspace-code-style-before-browser/run-20261030-140112-479914794`。现将同一个state hook移到条件返回前，不改方案格式或owner；新增`TC-IDE-C8-08-code-style-dialog-lifecycle-browser`，验证修改方案后重开、dirty正文与继续输入并纳入完整crash组。挂载及真实browser修后通过，后者为`workspace-code-style-after-browser/run-20261030-140435-834341389`，回执及5个附件已核验；三平台仍待完成。
- `cf1729a9854cdd64f694ee26caa2397230fdf379` 的 GitHub [41002449709](https://github.com/engcapa/taomni/actions/runs/41002449709) 已收齐并核验258次执行及6362个附件：**252 passed / 6 failed / 0 skipped**，与selection一致。Linux/Windows browser均43/43，macOS41/43；Linux native42/44、Windows42/42、macOS41/43。真实SDK061–063三平台及macOS菜单080通过；macOS browser070/073、native070及Linux native075仍有167.7–208ms长帧，Linux074与macOS072另有功能失败，不能按10%帧容差放行。本机标准browser19/19；matching release native22/23，070有191ms长帧；两组回执、source/runner/build身份及全部附件已核验，失败原件保留。本次dispatch漏选022和TREE-01，下一轮补齐完整73 ID并加入011/050，不声称258次等于原完整选集。
- 072已用真实共享编辑器挂载回归稳定复现：外层tab元数据保存正确，重载中断编辑器关闭effect后旧布局仍含records.json；恢复随后将它重新发布到外层。初次host对账现在通过原关闭/dirty确认/资源清理owner移除旧布局里已被外层关闭的root文件；中断open已提交的placeholder也保留所有权，由新请求清理。未提交tab的取消读取仍可被新请求重新打开，避免误当作用户已关闭文件。保留编辑器新打开文件、loose/library、dirty恢复和split语义。三条区分回归均有修前红、修后绿证据，最终相关17项通过；072增加重载前关闭结果断言，不等待存储timer、不改写store/storage；真实browser/native待新组合验收。
- CPU采样发现关闭的全局搜索框仍订阅所有workspace并构建索引。现仅打开时挂载索引、查询和焦点/键盘owner，关闭释放，重开读取最新文件/会话。隐藏索引回归改前红、改后绿；保留重新搜索、焦点、Enter和Escape。真实入口沿用011；050只验证工具栏/过滤器，不能当作搜索执行证据。树pointer选择不再对已点击行自动reveal，滚动目标相差不超过既有1px阈值时不触发同步无效scroll；键盘/外部选择仍reveal，测量重试/取消保留。两条改前树回归均红，修后与搜索/树4文件22项通过；074相邻文件误开及性能收益仍待实际验证。
- `06298dc33f977c72dae34ce05ed7ea3557c931f1` 的 macOS 诊断 [40997186885](https://github.com/engcapa/taomni/actions/runs/40997186885) 已收齐并核验25次执行：18 passed / 7 failed / 0 skipped，与selection一致；browser9/9、native9/16。065/069/075按诊断规则主动拒绝验收通过；061/062打开源码分别2788.3/4444.8ms、063恢复约1500.1ms、073冷notes帧191.9999999999991ms，原件保留。采样发现macOS主线程反复创建/替换/释放Tauri菜单，但061主线程大部分空闲，073长帧内也没有同量级已捕获DOM调用，不能称菜单已解释全部超时。
- 本轮针对菜单重复工作：语义相同的可见spec不再安装；完整创建/替换进入同一串行owner，过期排队版本不创建原生资源；enabled/checked变化原位更新，保留Tauri 2.12显式resource和action channel，失败回滚并允许下次publication重试。纯spec类型、builder和有副作用installer分为三个有明确输入/输出的模块，保持原facade API，避免反向依赖。回归24项及QA工具40项通过；新增macOS原生080通过真实NSMenu检查flags、Save写盘、Close、Quick Connect、About和reload后的回调，已注册schema/policy/dependencies。080本机Linux不适用，真实macOS执行和无诊断性能验证仍待GitHub，不据支持测试宣称提速。
- `a133d636ca41599654fc27de81ff17ba5b2f5ab6` 的 GitHub [40991754886](https://github.com/engcapa/taomni/actions/runs/40991754886) 已核验263次执行：**256 passed / 7 failed / 0 skipped**、与selection完全一致。三平台browser各43/43，Linux native46/46、Windows44/44；macOS37/44，061恢复、062/063打开普通文件动作超时，065/069/073/075长帧174/175/171/189ms；075慢帧发生于打开notes，首个source观察最大102ms。Linux57观察点3,540帧最大157ms，真实SDK三场景均通过；仍不能验收整体性能。macOS桥接记录显示JS执行多为0–1ms，但请求至renderer开始及无JS操作的HTTP返回也有数百毫秒延误，继续诊断，不扣除预算。
- 同source=`6fd0e5565fde811a95a04920cc15ace5460b01a5b58255dc943c1fef045b1c33`、runner=`9256b1d538f3a9f2e1426fe683e76a700d8ac36d0bd3d6b50c7c386bb3372516` 的本机支持测试392项、Rust桥接3项、refactor、完整前端构建通过；标准browser19/19（40点2,531帧最大146.1ms）、matching release native23/23及完整适用crash组通过。binary SHA=`7c3e02498ce11459951dcd7582d359cbdfb383ff8bf5306dd3246b9ef024f1b1`。新增默认关闭的原生任务/布局转发诊断；配置绑定conditions摘要，诊断用例不能被记为验收通过，后续正常性能运行必须关闭。
- `37cc6ff364a2f5fcaf3f1d42d18c630f8c9d1a2b` 的 GitHub [40986096085](https://github.com/engcapa/taomni/actions/runs/40986096085) 已结束并核验263次执行：**256 passed / 7 failed / 0 skipped**，与selection完全一致。三平台browser各43/43、Windows native44/44、Linux45/46、macOS38/44。保留Linux075的168ms，以及macOS061动作、068/070/073/079长帧和Maven终端未出现BUILD FAILURE的原始失败；不因后续某分片通过而改写旧报告。
- 新组合[40987880102](https://github.com/engcapa/taomni/actions/runs/40987880102)已核验263次执行：256 passed / 7 failed / 0 skipped，三平台browser各43/43、Linux native45/46、macOS38/44、Windows44/44。Linux074深层长行JSON为175ms；macOS061/062动作1681.6/1506.5ms，066/070/073/074长帧分别175.9999999999991/197/190/188ms，均未达验收。macOS061正文已在动作约595ms出现，但一次只读execute耗时1309ms且期间渲染heartbeat多数16–20ms；新增QA桥接排队/JS执行/回调时间戳用于分清该边界，原1500ms判定不变。
- 可选初始化任务各自两帧延后仍会聚集在同一paint前，叠加语法重配和工作区显示投影。新增回归先复现两项在同一轮执行，现共享队列每帧执行一项；不就绪的port不能阻塞其他pane挂载，取消、异常后续任务及卸载清理均保留。定向3文件16项与完整受影响组合12文件392项通过，refactor/边界合同通过；browser/matching native与GitHub验证继续执行；尚不据此宣称加速。内部调度保留064–079、TREEOPEN-01、SDK061–063与完整crash入口及原预算，无新增同义YAML。
- 按用户2026-10-30的要求，本轮继续在当前分支开发和验收；三平台全量及正式性能比较保留，main仅作为固定SHA的比较基线。
- 新组合`319dbe0c7d56a827df49f9131c29085ea75868bb`已推送并启动指定workflow [40987880102](https://github.com/engcapa/taomni/actions/runs/40987880102)：72 ID、263次执行、无能力缺口，source=`48b8855756bd159c59bf2cc5fe516dc438a89f5e632e263b17398e2927e67e73`、runner=`9256b1d538f3a9f2e1426fe683e76a700d8ac36d0bd3d6b50c7c386bb3372516`。本机matching QA release已完成（binary SHA=`8c03d0cd940da0ff0128f1a6c35ee190a13d14b8b9d1f9a6c30fdc01a72df7e3`），标准native `workspace-tree-measure-sdk-native/run-20261030-094122-536557264` **23/23 passed、0 skipped**，含完整适用crash9/9及061/062/063真实SDK成功/失败/Java场景。47观察点、3,039帧最大149ms，三个真实HOME布局均确认2,938文件、428目录、7层、320宽目录及64嵌套项目与指定八类文件。回执/附件摘要与source/runner/release均已核验；当前托管结果未收齐，不能用本机通过替代。
- `37cc6ff364a2f5fcaf3f1d42d18c630f8c9d1a2b` 已推送并启动指定workflow [40986096085](https://github.com/engcapa/taomni/actions/runs/40986096085)，仍为72 ID、263次执行、无能力缺口。source=`48b8855756bd159c59bf2cc5fe516dc438a89f5e632e263b17398e2927e67e73`、runner=`efc8e25422d2cb89fdd046a822b7d69968fcc38d976a4e17280646724505cc34`。本机标准browser最终18/19、完整适用crash7/7通过；066冷开242.70000000298023ms失败保留，当前源码未通过性能验收。后续SDK只读采集合并属于runner新身份，需单独记录，不覆盖此运行。
- 新的虚拟树修复将React ref提交时逐行同步高度读取改为等待ResizeObserver真实尺寸。回归修前捕获30次同步读取，修后4文件20项通过，并验证42px动态行高、总高度及后续行位置。保留077/TREE-01/TREEOPEN-01及064–079的真实入口，不新增同义YAML或关闭字体/动态行高能力；标准browser、matching release及新SHA托管验证继续执行。
- 新组合的TypeScript、refactor（768 commands/328 exports/39 events、918模块、4163文件）、catalog gate、SDK工具25项及trace4项通过。标准browser仍在执行，已保留066冷开242.70000000298023ms失败；CPU采样显示首次同步React渲染，存储写入仅0–0.2ms，不能将本机结果称作性能通过。其余完整崩溃组目前全部通过；后续matching release/native及GitHub验证用于判断发布构建边界。
- macOS062原始时序确认：最后UI结果在SDK启动后4492ms已出现，但独立pending观察又耗时582ms、trace采集64ms，释放gate晚于五秒。仅提前到trace前释放仍不足；现在把UI结果和真实IPC pending放到同一次只读请求中观察，随后验证新鲜子进程heartbeat，再立即释放gate并采集全部诊断。两步合同均先复现旧顺序失败，修后SDK工具25项通过。没有延长SDK超时、降低动作/逐键预算或修改062错误正文断言，原失败保留。
- GitHub [40980594603](https://github.com/engcapa/taomni/actions/runs/40980594603)（`93332b7a24b5cc82d580b003eda9e3f3788ab9ed`）已收齐并核验263次执行：**257 passed / 6 failed / 0 skipped**、与selection逐项一致；6,459个回执附件逐字节/SHA及source/runner/release身份已核验。三平台browser各43/43，native Linux44/46、Windows44/44、macOS40/44。Windows030真实监听替换/磁盘冲突已通过。剩余Linux074/075为176/261ms，macOS070/074/079为203/200/183.9999999999991ms；macOS062因末尾独立pending观察及trace采集延误gate而显示五秒timeout。全部原始失败保留，当前不验收；source=`2e563f76e79a0ca04c27279221b9a53357e2bcd33e78a0dd39d9c357885550dd`、runner=`34476c3112421afc5b0c2eefb248a2a836298cc68d601d8619e9e02ff5818607`。
- 同source本机标准browser `workspace-host-watcher-browser-perf/run-20261030-083245-366129456`为7 passed/1 failed：064在第1步goto被另一同URL导航打断、尚未进入性能测量；其余066/068/069/070/073/077/078通过。保留该失败，064单独恢复运行`workspace-host-watcher-browser-startup-recovery/run-20261030-083923-935901340`为1/1通过，冷开正文219.4ms/高亮363.7ms、恢复/重开最大帧109.4ms。两批回执及附件摘要已核验，共40个观察点、2,537帧、最大155.3ms；仅1帧处于150–165ms容差区间，不能称作同条件加速或用本机结果替代GitHub。
- GitHub [40972368025](https://github.com/engcapa/taomni/actions/runs/40972368025) 已收齐并核验263次执行：**255 passed / 8 failed / 0 skipped**、与selection一致，无缺失。三平台browser各43/43；native Linux44/46、Windows43/44、macOS39/44。七项为性能失败；新增Windows030为真实外部写盘后冲突框未出现，失败页明确显示`File watcher unavailable: workspace watcher initialization cancelled`，不能按性能容差接受。原始回执及全部附件保留。
- 监听器旧effect的stop与新start异步并发，workspace级stop会取消替代注册。当前在原IPC上增加可选注册ID，cleanup只取消其所属注册；保持旧调用及完整workspace释放语义，并处理卸载后才完成的初始化。前端回归修前3失败、修后相关16项通过，Rust真实监听器/生命周期12项通过，TypeScript、Rust formatting、refactor及catalog gate通过。030保留全部恢复/凭据/磁盘冲突断言，增加目录折叠/展开触发监听器替换，全部精确checkpoint和actions/results映射已核对；dry-run只证明语法。匹配release及三平台真实写盘验证待完成，没有放宽等待或预算。
- 外层标签请求与工作区展示现在分别订阅：请求桥继续即时协调真实buffer、取消迟到请求、恢复draft和同步canvas；文件列表/活动文件变化不再先用旧buffer重画整个Runtime。真实挂载回归修前在选择已打开文件时捕获旧activeKey额外重画，修后通过，并检查同一EditorView、dirty正文、无重复读取与undo；host/canvas及完整工作区生命周期支持测试23/23通过。保留069/073/075及原拆屏/恢复入口，无新增同义YAML；新的matching release、标准browser/native及GitHub三平台结果待执行。
- GitHub 40972368025已确认三平台browser各43/43，Linux native44/46；063第7键167ms、075冷源码197ms均超165ms。已收macOS native分片的061动作超1500ms、069/073分别207/200ms也失败；其余native仍在收集。原件保留，本机诊断不替代托管验收。
- `f8ea6eb6f590320446ddfab91db8c1f0ccd82652` 已推送，并通过指定workflow启动 GitHub [40972368025](https://github.com/engcapa/taomni/actions/runs/40972368025)。本地plan为72 ID、三平台browser/native/release、263次执行、无能力缺口；dev contract通过。source=`eda0484ca14c049eef29d78675e37f331b27edeb1dacaf54f6d2ed30416eafd6`，runner=`34476c3112421afc5b0c2eefb248a2a836298cc68d601d8619e9e02ff5818607`。本机matching QA release已构建完成，耗时716.70秒，binary SHA=`cc6323e2fa103654cec19f349cba79e0269a21f82dcdff83b8b996df62ca7e42`；本机native专项25/25及完整适用native崩溃组9/9均已通过、无skip，输入身份稳定，回执签名及附件摘要已核验。native57个文件观察点3,805帧最大108ms；074/075/079均确认2,938文件、428目录、7层路径、320宽目录及64嵌套项目，指定八类文件齐全。托管原始case结果尚未收齐。
- 新口径下的标准browser `workspace-frame-approved-browser/run-20261030-070809-539831857` **19/19 passed / 0 skipped**，含完整适用崩溃组、剪贴板/导航及064/066/068/069/070/073/077/078；输入稳定、回执签名和附件摘要已核验。40个文件观察点共2539帧，最大128.6ms；本轮没有帧进入150–165ms容差区间，不据此宣称同条件加速。TypeScript、refactor、catalog gate及测量工具25项通过；matching release正在构建，native与三平台结果待完成。
- 用户于2026-10-30补充接受“长帧不超过10%的慢”：当前按单帧150ms基准允许最多10%偏差，即**每一帧≤165ms**验收。报告同时记录150ms基准、10%容差、165ms上限及未取整原始帧；正文/高亮/动作1500ms、输入p95及真实SDK五秒超时不变。旧报告保留原判定，不回写通过；后续须以新runner/case身份执行。本项是用户调整验收口径，不是产品性能提升，不能豁免超过165ms或功能失败。
- 按用户要求清理本机测试产物：确认无cargo/rustc/该QA binary运行后，仅移除旧`src-tauri/target/qa-ui-auto/debug`，释放19,612,114,944字节；SSD可用由9,848,877,056增至29,460,987,904字节。release二进制SHA在清理前后均为`8618c682cab63c1f72de07960fea721ed1f11b9ebb8c1b9930391aee1e77d12f`；源码、原始失败证据及release缓存保留。记录在`_local/workspace-disk-cleanup-20261030.json`。
- 树选择隔离后的标准browser `workspace-tree-final-browser/run-20261030-064822-585915889` 为18 passed / 1 failed / 0 skipped；069切回notes首帧153.3ms按当时150ms标准失败，原件保留。CPU采样显示外层tab选择和内部文件激活连续同步提交；存储写入仅0–0.2ms，不能归因于持久化。该报告不因新容差追认通过，matching新输入执行待完成。
- `27d95ada904ecdd1f046e56f0c7d82d611208e35` 的 GitHub [40961872846](https://github.com/engcapa/taomni/actions/runs/40961872846) 已收齐260次执行：**246 passed / 14 failed / 0 skipped**，与selection逐项一致。browser Linux43/0、Windows43/0、macOS42/1；native Linux44/1、Windows43/0、macOS31/12（通过/失败）。仍未达到验收：macOS冷开/切换最长失败帧157–255ms、061打开源码1786.3ms、062恢复1843.8ms、063最后普通文件动作期间真实SDK已结束；Linux075记录150.0000000000009ms也原样保留为失败，不放宽阈值。原始回执、source/runner/release及附件摘要已核验；尚不启动正式性能比较。
- 上述已提交source=`c4b338fb08aa79d176372e47e545e326128558ca303f8182f28afb66c52c5ebb` 的本机标准browser18/18、native专项24/24及完整适用native crash9/9均通过。browser40观察点2541帧最大104.9ms，native57观察点3747帧最大123ms；010在此前复现prompt缺陷的同长度报告路径中无注入通过，三个真实HOME布局及指定八类文件全部核验。这些本机结果不替代GitHub剩余失败。
- 树选择诊断确认仅点击选中就触发整个Runtime约20ms提交，紧接着才是实际文件激活。当前把treeSelection订阅放到独立Project pane，Runtime仅订阅其他UI字段；文件/目录创建、rename/delete、Enter/F2/Delete及命令派发在入口读取当前选择，显式上下文目标优先，已打开对话框固定原目标。菜单投影独立订阅本实例选择并在卸载时清理；Java新建仍从实时选择解析目录。真实mounted回归修前多2次owner渲染，修后树点击/连续方向键不再重画owner；完整CodeWorkspaceTab256项、文件动作15项、菜单5项及Java模板8项通过，TypeScript通过。纯内部订阅重构，沿用现有077/TREEOPEN-01、新增选择TREE-01及C8-07真实文件创建/undo保留场景，无同义YAML新增。匹配新源码的首轮标准browser为18/1（069首帧153.3ms，按当时150ms标准失败）；新容差下的新身份验证继续执行，尚无新源码native/托管性能结论。
- `dba8c361568b3bbf8d148f2733987ac889faa94f` 的 GitHub [40952190607](https://github.com/engcapa/taomni/actions/runs/40952190607) 已结束：**243 passed / 17 failed / 0 skipped**，260次执行与计划逐项一致。browser Linux43/0、Windows43/0、macOS42/1；native Linux42/3、Windows43/0、macOS30/13（通过/失败）。6,390个回执附件逐字节/SHA及source/runner/release身份已核验；Windows原生fixture、工具窗与HOME清理通过。失败包含macOS冷开长帧、061/062响应预算，以及Linux074/075长帧和063输入帧，全部原始证据保留，尚未验收。
- 同source=`dfb2b7445da7c37b112349ce7cdddd688ac3f11dcb264f65bbf3b062e825e07c` 本机最终组合：browser18/18、native专项23/24、native完整适用crash9/9。全部性能断言通过，browser40个观察点2,551帧最大108.2ms，native57个观察点3,738帧最大120ms；三个HOME布局均验证2,938文件/428目录/7层/320宽目录/64嵌套项目及指定八类文件。唯一native失败为010终端prompt已出现但ready超时，保留现场继续定位；这些结果不能抵消托管失败。
- 冷开React提交采样确认首次status widget host注册和viewport测量会重画整个编辑器；另有空inlay/semantic/breadcrumb更新在外部store提交期间排入无变化的transition。当前将status slot订阅移到工具栏，viewport交给语义请求订阅，并在显示投影排队前去除真正无变化的更新。修前status host回归重画3次、viewport回归多1次、空overlay回归多2次；修后各项通过，inlay保留最新视口刷新、过期结果拒收及卸载取消。完整编辑器及相关消费者9文件299项、TypeScript/Vite/refactor通过。保留即时文件/命令目标、完整高亮及原150/1500ms预算；matching release及新SHA托管结果待完成，诊断注入不构成验收。这是显示投影内部重构，沿用064–079和现有LSP/拆屏保留用例，不新增重复入口用例。
- 旧源码隔离worktree的 `workspace-prompt-length-diagnosticxx/run-20261030-053845-196522077` 稳定复现010终端ready超时：真实Bash/readline在224字符prompt恰好占满112列的两行后发送CR/LF/CR，光标落在无isWrapped的下一空行。现在仅在bracketed paste开启、空行首及前一行末格确为已打印空格时检查相邻prompt，拒绝旧输出/补齐空格/半条命令/alternate screen。真实xterm重放112/224列回归修前2失败，修后连同CWD安装、预览和命令解析4文件39项通过；原010原生会话/输出/隐藏恢复断言不变，matching release及实际native重验待完成。

- 恢复时当前分支为 `5354899c`，远端分支仍为 `dc33439e`；远端 main 仍为 `569d09327f251e123a2d78881585683f85f5b6c1`。保留当前分支和隔离测试桌面，不操作用户 profile 或读取私密 fixture。
- 续建 `5354899c` QA release 后，本机 `workspace-resume-native/run-20261029-190044-875887466` 为 **4 passed / 3 failed**：074/075/076/077 通过，065/067/073 冷打开最长帧 189/227/175ms。证明焦点/末行几何/HOME/Run 修正的实际边界，不代表性能通过。
- 后续采样发现首次文件改变菜单所有权会同步重画整个主窗口；菜单消费者现在自行采样或订阅当前所有权。`TC-WS-078` 保留首次文件 Close 可用、dirty Save 真正生效、关闭最后文件后禁用、切换 Sessions 后贡献释放、重开已保存正文的流程。修前3项 mounted 测试失败，修后菜单/Actions/语言5文件39项通过；078 browser 通过。
- Project 树按显式行输入划分默认 memo 边界，保留真实 callback、Git/dirty、压缩路径、列表元数据及 locale 订阅。语言扩展按固定语法配置缓存，失败可重试；加载安装排在文档首次测量帧并取消过期文件结果。没有关闭高亮或修改150/1500ms预算。
- 剪贴板消费者注册时，根 hook 的完整快照订阅触发同步全工作区重画；订阅移到属性/状态观察节点，原 lifecycle、权限适配器和桥接观察不变。回归修前 owner 多渲染1次，修后 clipboard/真实编辑器5文件310项和观察边界2文件6项通过。
- `workspace-clipboard-browser-02/run-20261029-194533-955730838` 仍为 **1 passed / 2 failed**：078通过，064/073最长帧195/170ms。这是当前冷初始化进一步拆解的依据，不能宣称性能完成。
- `a6cf6e1b` 的 matching release 本机 `workspace-render-boundaries-native/run-20261029-200206-284996258` 为 **4 passed / 4 failed**、身份稳定：TREEOPEN-01、073、076、077通过；065/067/074/075仍有188/203/154/193ms长帧。不能把此前某一轮通过拼成组合源码通过。
- 同 SHA 的 GitHub [40870063931](https://github.com/engcapa/taomni/actions/runs/40870063931) 已修复 catalog gate 并开始三平台相关集。browser 共 **122 passed / 7 failed**、无skip：Linux43通过，Windows41通过/2失败，macOS38通过/5失败；全部失败均为150ms帧预算。native仍待汇总，不能以shard job的success替代case结果。
- 当前继续试验首次EditorView构造与workspace激活分帧，并只延迟导航可见性/portal投影。文件、活动目标、pane列表仍在同步tab提交中传递；新增同步切换回归保护输入目标。编辑器集成测试改为等待真实正文挂载，保留分屏/undo/剪贴板/保存竞态原断言；10条分屏相关定向回归已通过，完整组合回归及matching release待执行。
- 当前分支标准 browser `workspace-safe-navigation-browser/run-20261029-202437-113973692` 为 **7 passed / 0 failed / 0 skipped**、身份稳定，93个回执绑定附件摘要已核验：064/066/068/070/073/077/078。全部原始观察点最大帧130.1ms；JSON冷开正文270ms/高亮381.6ms、长行JSON277.5/367ms、Home返回119/110.4ms。只说明本机browser当前产品调度通过，不能替代native或三平台验收。
- `40870063931` Linux native为 **39 passed / 4 failed**；064/067/075最长帧154/160/160ms，074在异步展开子项期间提前报告行不存在，失败HTML随后已包含该行。`project_tree_reveal`现在仅在真实可见loading状态中有界等待，保留滚动样本、缺失/超时失败与所有预算；工具及file-open合同24通过，需在新runner身份下重验074。
- `workspace-yield-browser-crash/run-20261029-203545-418445277` 完整适用browser崩溃组 **7/7 passed**；TypeScript、refactor、catalog gate通过。支持性组合测试12文件388通过/1失败，最后一项也是新split正文就绪等待，修后完整CodeWorkspaceTab重跑 **254/254 passed**；matching QA release仍在进行。
- `40870063931` macOS native已出现069滚动箭头无法露出budget.csv（功能失败）和068的155ms长帧；其余shard及Windows仍待收集。069不能套用性能例外，须检查滚动控件/布局/原始驱动证据后修复。
- 这属于内部调度优化，沿用064–077、TREEOPEN-01和078的实际用户入口，不新增同义YAML或删除预算。先前隔离工作树的browser通过仅作为假设依据；当前分支无注入验证及GitHub新SHA仍待完成。
- 本轮尚需 matching release 专项、指定 GitHub workflow 三平台相关集、当前分支全量和正式四轮性能比较。此前暂停快照的65 ID选集仍保留，并加入 TREEOPEN-01、078及受影响剪贴板入口。
- `4bfccf02` 的 GitHub [40876274070](https://github.com/engcapa/taomni/actions/runs/40876274070) 仍未通过：browser Linux41/2、Windows38/5、macOS37/6；native Linux39/4、Windows39/2、macOS35/6（通过/失败），全部已结束。回执签名、逐附件字节/SHA、源码和QA release身份已核验；job success不能替代case结果。主要剩余项为150ms长帧、慢读取空白编辑器、标签滚动及异步挂载瞬态。
- 慢读取超过80ms后已发布loading buffer，编辑器port注册曾提前消费树焦点intent；读取回调随后误判过期并丢弃正文，留下永久空白只读编辑器。现在只在读取完成、canonical key确定后授予焦点，读取有效性独立于焦点intent，并保留新请求/卸载失效。真实openFile/store/hook的4项回归修前全失败；修后与焦点、滚动等5文件30项通过。
- 标签栏箭头手动滚动曾被resize/metadata通知重新拉回活动标签；现在用户滚动保持控制权，活动文件/工作区改变时再自动显示活动标签。真实滚动回归修前失败、修后通过；069原始输入及预算保留，跨平台执行仍待新SHA验证。
- HOME和超过256条目的非项目大根不再递归寻找所有子仓库；活动文件通过受根路径约束的祖先查找发现最近Git仓库。普通项目的nested仓库发现、snapshot并发2/TTL/去重/轮询/手动刷新保留。根与活动文件发现分开管理迟到结果，HOME自动描述符发现始终浅扫，显式刷新保留。Rust workspace合同80项、Git发现hook11项、描述符scope等10项通过。
- 新增079使用真实HOME下owned公开目录、一个活动Git仓库及一个无关仓库：打开前零snapshot，打开普通文件后只取活动仓库snapshot并验证真实M状态，继续断言SDK/LSP零启动及150/1500ms预算。fixture/schema/policy/dependencies已注册；工具19项、观察器16项、catalog gate及三平台plan通过；dry-run只证明语法，079实际执行尚待matching release。
- C3-01/AUDIT-009/IMPROVE-007现在有界等待原有异步consumer/EditorView条件；039在返回文件后等真正breadcrumb portal，再断言单一共享bar及pane内容。未删除原断言、未提高性能预算。本机browser `workspace-demand-browser-functional/run-20261029-212011-917096979` **9/9 passed、无skip、身份稳定**，包含完整适用browser crash组及C3-01/077，22个回执附件已核验。
- 当前组合支持测试：CodeWorkspaceTab等9文件298项、TypeScript、refactor边界检查均通过；HOME描述符scope是其后的独立10项支持证据。matching QA release正在编译，之后串行执行065/067/073–077/079/TREEOPEN-01；本次尚无当前源码native性能通过结论，完整native crash组、受影响保留能力及新SHA三平台相关集仍需执行。
- 上述 source=`65ee9569cc9b14c3f4d70457cd1616ddf4e2b1c743a0cb029a39923db87aaf1e` 的 matching QA release（二进制SHA=`d00c925f56eb94d22fc9dbff326d1fd5a77d8b7fd24ac30c9bed92c8b67ba1f8`）标准 native `workspace-demand-native/run-20261029-213243-052588571` 为 **8 passed / 1 failed、无skip**，1,043个附件逐字节/SHA及回执身份已核验。065/067/073/074/076/077/079/TREEOPEN-01通过；075源码冷开正文373ms、高亮556ms，但最长帧197ms，仍失败。079实际HOME Git只取活动仓库且验证真实M状态，普通文档路径仍零SDK/LSP启动。
- 075的JSC与转发调用诊断保留241/277ms失败样本：文件读取仅3ms，自动LSP/SDK/Run发现却在真实EditorView首帧前开始，引入额外状态提交和布局。当前自动Run、server发现等待真实编辑器port及非loading正文，再让出测量帧/paint；document didOpen延迟试验已撤回（见下）。显式刷新与同步入口保持即时，未改变SDK五秒超时或150/1500ms预算。新增回归修前2项失败；真实editor-ready接线后的3文件48项通过，完整集成与新matching release待执行。旧binary不匹配这一轮产品源码。
- 用户补充：GitHub上模拟HOME场景的性能通过可以作为验收。以runner真实HOME下owned公开fixture、匹配native QA release和原始全观察期预算为准；074/075/079覆盖普通文档、源码和活动Git路径。不得以browser stub、仓库内普通目录或未通过的局部样本替代，用户手工复测不再作为此HOME场景自动验收的必备前置。
- 按用户要求增强当前HOME负载：共享fixture在真实HOME下创建唯一owned公开子树，实测2,938文件、428目录、最大7层、320文件宽目录和64个嵌套项目描述符。覆盖log/txt/md/json/java/ts/py/sh，以及html/csv/xml/yaml/ini/rs/go/css/svg/data/bin；每次保留实际文件系统统计 `home-fixture-layout.json`，不清点或复制HOME其他内容。074增加逐级展开、深层长行JSON的精确正文/高亮/复用/全帧预算和返回dirty草稿；075与079共用同一负载。15项fixture/滚动工具测试、catalog gate及三条dry-run通过，真实UI执行待新release；dry-run不算性能通过。
- Windows旧run的074准备阶段记录targetBottom=697.75、viewportBottom=697.5；`scrollIntoView(nearest)`把偏移取整后仍裁切0.25px，240次没有继续移动。reveal工具现按实际几何向上/下补足整像素滚动，保持严格可见性判断、不改正文/帧预算；新增工具回归修前失败、修后通过。
- 首次paint调度的集成回归发现：延后自动document didOpen会使库源码导航和尚未启动的文档同步产生时序退化，完整测试曾出现渲染循环/OOM。已撤回这项未验收试验及其提取模块，恢复原document open生命周期；当前仅延后自动Run及server能力发现。诊断采样和失败日志保留，临时注入已移除。符号导航支持测试明确等待provider真实宣告符号能力，保留原文件搜索fallback及URI解析断言。完整编辑器组合回归与匹配构建继续进行，不把试验的48项支持测试当作最终实现已通过。

- 保留自动document open生命周期后，完整组合 `workspace-source-paint-retained-03.log` **6文件308项passed**，覆盖真实编辑器、树慢读、命令owner、自动Run/server让出及显式刷新。Java Run测试等待真实可用按钮，默认Java探测mock保留Promise失败合同，不再用undefined制造伪状态覆盖；原终端与cwd断言保留。HOME fixture/树与标签滚动/观察器30项通过，Rust fmt及TypeScript/refactor通过（768 commands、328 facade exports、39 events、910模块、4140文件）。当前source=`2f7adbff962eafef130b83e40f12cde2f05559fd241403a2adfd017d454236e6`，matching QA release正在编译，尚无这批大HOME负载的真实性能通过结论。GitHub workflow计划阶段也执行HOME fixture结构、指定文件类型及owned清理合同。
- `c6286d22` 的上述 QA release 已构建完成（二进制SHA=`fdf195b5f8d21b953d02f868ef3e8e2c547de1b8bc3339db233bd51ee7ca5a3d`）。本机 `workspace-home-layout-1-browser/run-20261029-225859-931420313` **15 passed / 1 failed**，唯一失败068冷notes最长帧160.3ms；匹配 native `workspace-home-layout-2-native/run-20261029-230932-998884638` **9/9 passed**，含065/067/073–077/079/TREEOPEN-01；`workspace-home-layout-3-native/run-20261029-231216-594701753` 完整适用崩溃组 **9/9 passed**。三个run的134/1056/292个附件已逐字节/SHA和回执身份核验；这些是c628源码的结果，不能替代后续修改。
- 同提交 GitHub [40895271908](https://github.com/engcapa/taomni/actions/runs/40895271908) 已完成 **241 passed / 16 failed / 0 skipped**：browser Linux43/0、Windows43/0、macOS42/1；native Linux37/7、Windows40/2、macOS36/6（通过/失败）。三平台QA release均构建成功，6,344个回执附件逐字节/SHA及source/runner/profile已核验。Linux native失败为065/066/070/073/074/075/079的152–187ms长帧；macOS native067/068为156/170ms长帧。不能以job成功或HOME个别平台通过标记验收。
- 其余托管失败已逐项定位：039和native工具窗快捷键的即时断言读到异步portal/rail提交前的状态，失败HTML随后是正确单bar/aria-pressed；现在在原精确断言前有界等待真实目标状态，保留所有pane/草稿/几何/PTY断言及verification映射。Windows/macOS 069原始样本在scrollLeft=0与255/264间振荡，固定翻页越过目标标签另一边；箭头现在先完整显示边缘标签再继续翻页。真实几何回归修前失败，修后与滚动生命周期14项通过。
- Windows 079的性能与真实Git断言完成后，owned fixture清理遇到Git只读object的WinError5。清理现在仅对owned树内的PermissionError补写权限后重试，其他错误继续失败，不glob/不接触其他HOME路径。5项fixture支持测试通过，真实Windows清理待新runner验证。
- 冷开CPU profile显示Actions snapshot反复读取native-backed navigator属性；120个action的一批快照修前读取964次。现在一批snapshot/binding index只解析一次platform/locale，下一批仍识别变化，原派发/冲突/显示合同不变。新增回归修前失败；修后快捷键/Actions56项及编辑器/设置消费者281项通过。仍沿用064–079等实际入口验证，支持测试不构成性能结论。
- macOS 061/062原始trace显示普通文件正文分别在动作开始后1028/1022ms出现，但驱动结果/观察往返使动作总耗时1514/1741ms，原失败保留。QA桥在确认全部input ticks完成的同一次观察中消费任务，取消成功路径的重复cleanup evaluation，错误/超时仍清理并取消迟到ticks；不减少真实输入、不重放动作、不更改1500ms动作及5000ms SDK超时。桥键盘/指针21项通过，matching release与三平台原用例仍待验证。
- 上述组合本机 browser `workspace-binding-browser/run-20261029-233451-758746202` **16 passed / 0 failed / 0 skipped**，含完整适用崩溃组、C3-01、064/066/068/069/070/073/077/078；142个附件和回执已核验。JSON正文264.7ms/高亮355.3ms、长行JSON261/337.6ms、冷notes正文251.2ms，原160.3ms失败路径本轮117.9ms。随后构建类型检查发现新增支持测试缺少必填category，已补齐且该项回归重跑通过；这是测试类型修正，产品行为不变，但源码身份保守变化，最终仍以新SHA的GitHub结果及匹配native构建为准。
- 修正已分为Actions批处理 `735da34e`、标签箭头 `8936c39e` 和验证工具 `80f32c3a174d03328b3c9c220e587cbfc10d2c61` 三个提交并推送。TypeScript、Rust fmt、refactor、catalog、dev contract及257次三平台相关集plan通过；GitHub [40905529591](https://github.com/engcapa/taomni/actions/runs/40905529591) 使用该完整SHA、原70 ID、browser/native/release正在运行，尚无托管通过结论。
- 同源码 source=`0ee6ecf6da5bef306e4bbd85f444084278641dbb468e63377df491e175e1cc6a` 的本机QA release构建688.92秒，binary SHA=`02bc4c1eb0576315944a15d58b1054448358a791d92c4aa9c127bd3fe4599e49`。`workspace-binding-native-targeted/run-20261029-235820-229533292` **13/13 passed**，含061–063真实SDK、065/067/073–077/079、TREEOPEN及工具窗；`workspace-binding-native-crash/run-20261030-000200-288928528` 完整适用崩溃组 **9/9 passed**，无skip、身份稳定，1179/292个附件逐字节/SHA和回执已核验。JSON冷开正文259ms/高亮366ms/max帧95ms，长行JSON267/367/107ms；HOME深层长行JSON143/215/72ms、源码262/397/96ms、Git普通文档240/630/88ms。三个HOME用例均保留实际2938文件/428目录/7层/64项目/320宽目录统计，指定八类文件全部存在；本机通过不替代GitHub验收。

- 当前 GitHub `40905529591` 三平台 browser **129/129 passed、无skip**（每平台43），564个回执附件逐字节/SHA及source/runner已核验。macOS首个native分片 **11/11 passed**，含067长行JSON、075真实HOME源码；075冷开正文594ms/高亮869ms/max帧143ms，仍使用原1500/150ms预算。Linux/Windows及其余macOS native待收齐，不据局部通过标记验收。
- `40905529591` 最终为 **251 passed / 6 failed / 0 skipped**，257次实际执行与计划逐项一致；三平台browser各43/43，native Linux39/5、Windows42/0、macOS41/1（通过/失败）。6,360个回执附件逐字节/SHA、source/runner及QA release身份已核验，基础设施错误为空。Windows/macOS标签滚动和Windows owned Git清理通过；剩余Linux064/065/068/073/075为181/174/161/154/201ms长帧，macOS062清空源码动作1980.67ms，仍不验收。所有原始失败保留在 `_local/workspace-40905529591/`。
- 冷开采样显示EditorView构造后的整个workspace状态投影与首次测量/高亮叠加；`startTransition`不能保证先绘制。命令port、路由和实时caret refs仍同步，仅菜单revision、光标/viewport展示更新改为两次rAF后的合并transition，卸载取消全部待处理任务。真实command owner回归修前多渲染一次，修后即时action仍成功且绘制前不重画owner；队列StrictMode/顺序/unmount等及完整编辑器组合 **6文件281项passed**。内部调度沿用064–079/TREEOPEN/078入口与原预算，不新增同义用例。
- macOS062原始HTTP trace中普通源码打开529.9ms，随后fill的contenteditable观察985.2ms、全选204ms、Backspace666.9ms，最终正文正确清空。当前SDK被动trace增加连续renderer帧心跳以区分真实停帧和桥等待，保留每个间隔及完整动作1500ms判定，不用DOM时间替代；Python/Node工具合同19项通过。上述新产品调度尚需新源码browser、matching QA release及GitHub三平台原相关集验证，旧binary结果不冒充当前通过。
- 新调度 source=`91855c8132d524e10ebbb21872ffc73eb86e4a8badcc3ddece2a9786f85156d1`、runner=`ab13ec226bdb82042b07c11901967159eb204ea9f9cb4487b74abaf9ba6239a4`：本机 `workspace-after-paint-browser/run-20261030-005536-280194345` **16/16 passed、无skip**，含完整适用browser崩溃组，142个附件及回执身份已核验。全部文件打开观察点最大帧114.2ms；704行JSON正文240.9ms/高亮332.8ms，长行JSON244.2/324.1ms。TypeScript、refactor及dev contract通过；matching release构建和本机native专项/崩溃组继续执行，三平台GitHub新SHA待派发。
- 上述源码本机 native 专项 **19 passed / 1 failed**，性能断言全部通过，唯一失败为工具窗 terminal ready 超时；完整适用native崩溃组 **9/9 passed**，回执/附件/QA release身份已核验。GitHub [40918244213](https://github.com/engcapa/taomni/actions/runs/40918244213) 最终 **243 passed / 14 failed / 0 skipped**：browser Linux43/0、Windows43/0、macOS41/2；native Linux36/8、Windows42/0、macOS38/4（通过/失败）。6,340个附件逐字节/SHA及全部回执签名、source/runner/release身份已核验。Linux064/066/067/068/070/074/075/079仍有158–228ms长帧；macOS browser070/073及native064超150ms，native061/062/063仍失败。尚未验收。
- 冷打开诊断约20次React提交，首次EditorView构造、workspace投影、几何测量与语言安装仍会叠加。当前首次挂载与语法安装都使用两轮rAF后独立任务，让前一个阶段有绘制机会；继续复用后续文件的EditorView，保留过期文件/卸载取消和语言失败清空。没有延迟document didOpen、关闭高亮或改变预算。直接回归修前4失败/4通过、修后8/8通过；CodeWorkspaceTab完整 **254/254 passed**。两个code action集成回归在原操作前等待真实正文，保留全部journal/undo断言。内部调度继续沿用064–079/TREEOPEN/078，无同义YAML新增。
- `workspace-paint-stages-browser/run-20261030-015535-751914446` 的16条全通过，但执行期间支持测试发生修改，`identity_stable=false`，不算当前验收；固定输入后的标准browser、matching release及native专项/完整崩溃组待核验。
- macOS新被动trace区分出驱动往返开销：063清空总1620ms，renderer最大心跳间隔112ms，其中一次只读执行请求582ms；061普通文件正文在动作开始后912ms出现，但总1512ms并耗尽真实SDK五秒等待。062真实probe在gate释放前超时，因此不能期待fixture非零退出正文。原失败全部保留。客户端仍保留桥同步执行时代的Darwin逐字符HTTP workaround，而当前桥已按每tick duration异步执行；现在将paced输入所有权提取到`native_paced_input.py`，所有平台共用单请求键序列，保留每个keydown/up、Shift、20ms暂停、失败释放与禁止重放。新增工具回归修前Darwin失败、修后Python46项及原桥异步逐键观察/取消2项通过。SDK逐键帧、每八键1500ms、全部字符/总耗时、同一真实pending子进程与5000ms超时合同不变；macOS原用例仍需新runner托管验证。
- 当前source=`be6394c1194c069ecb30df0c3e5f9229f36edad8fa5f65c8ea5098025f9de0a9`、runner=`773fc7622c08eb7a8e8d41564183e56e19393175ceb77e01c58abf65cbbec53d`。matching QA release构建734.24秒，binary SHA=`ff46cd4af64973a505e62f60dafceaa0c6bf845fb2b6b0cc172e7bc87694600d`；TypeScript/Vite、refactor（768 commands/328 exports/39 events、911模块、4143文件）和catalog gate通过。稳定browser完成后串行运行native专项20项与完整适用崩溃组9项；当前三平台性能仍待新SHA验证。
- `263fe34aa395af420ddd8964e5346050fa7afb5d` 已推送并通过指定workflow启动 GitHub [40929042049](https://github.com/engcapa/taomni/actions/runs/40929042049)：原70 ID、三平台browser/native/release，selection为257次适用执行、无能力缺口。dev contract通过并提示无YAML变化，原因与保留入口已记在上文；原HEAD源码不变。
- 同source/runner的本机稳定browser `workspace-paint-stages-browser-stable/run-20261030-021125-728218642` **16/16 passed**，native专项 `workspace-paint-stages-native-targeted/run-20261030-022050-214040648` **20/20 passed**，完整适用native崩溃组 `workspace-paint-stages-native-crash/run-20261030-022652-002094609` **9/9 passed**；均无skip、输入稳定，142/1393/292个附件及回执、matching release身份已核验。全部文件观察点最大帧browser115.7ms、native119ms。native704行JSON正文259ms/高亮375ms/max88ms，长行JSON291/403/103ms；HOME深层长行JSON147/231/119ms、源码265/382/111ms、活动Git普通文档285/661/87ms。074/075/079实际布局均为2938文件/428目录/7层/320宽目录/64项目，八种指定类型全部存在。输入及相关消费者支持测试107项通过。这些本机通过不替代仍运行中的GitHub验收。
- GitHub [40929042049](https://github.com/engcapa/taomni/actions/runs/40929042049) 已结束：**252 passed / 5 failed / 0 skipped**，与selection的257次执行逐项一致、无缺失。browser三平台各43/43；native Linux42通过/2失败、Windows42/42、macOS39通过/3失败。6371个附件的大小/SHA、回执签名及source/runner/release身份全部核验。Linux074深层长行JSON为185ms长帧，075源码冷开首个失败帧157ms且后续还有191/163ms；macOS061/063最后普通文件操作分别1833/1516.6ms，042在Add Folder点击阶段120秒超时。所有失败保留，未放宽150/1500ms或真实SDK五秒超时。
- 仅作诊断的 `workspace-home-stages-diagnostic` 发现Actions快照在React渲染期间通过 `scrollDOM.clientHeight` 触发同步布局。当前把Page动作可用性几何读取移至CodeMirror共享测量阶段并缓存；隐藏View仍禁用，实际Page命令继续使用实时几何。普通HOME文件无Git祖先、干净文件恢复中心空列表及空语义高亮结果不再提交相同的可见状态；持久化协调、真实匹配和清除、非空Git结果及迟到响应保护保留。这些内部修正沿用064–079、原Page动作/恢复/高亮入口，无新增同义YAML。
- macOS真实模态NSOpenPanel可能等待关闭后才返回WebView点击。`native_folder_dialog`增加 `trigger`，由一个真实driver点击与已有owned OS操作器同时完成，同步等待两者并保留失败；022/026/030/042合并原点击与OS步骤，所有结果与checkpoint断言保持。已聚焦的contenteditable保留当前焦点后发送真实Mod+A/Backspace或逐键输入；未聚焦仍必须真实点击并验证焦点，不合成或重放输入。新的matching release、本机标准执行与GitHub验证待完成，诊断注入不能用于验收。
- 本轮支持回归：几何/Git/恢复/高亮与保留能力15文件208项通过；完整CodeWorkspaceTab在StrictMode双编辑器测试等待两个真实正文挂载后 **254/254 passed**，原跨分屏复制/粘贴/undo及lease断言全部保留。Python真实输入、目录选择器和共享消费者 **160/160 passed**。073追加PageUp/PageDown、Shift翻页选择及Actions搜索执行Page Down，并保留干净JSON、另一标签dirty正文和原全部性能观察；控件catalog已同步。四条OS用例把trigger展开后与原步骤逐项相同，五条变更用例的checkpoint与实际步骤完全一致。catalog gate通过（4个既有orphan未增加）；新增022后的71 ID托管selection为260次适用执行，无能力缺口。dry-run只算语法验证，030使用明确的一次性占位密码解析，不连接SSH；030真实SSH/SFTP恢复留给GitHub提供的服务验证。
- 固定source=`7410c24bd80059537c496a1e9e62b72388afcfe317b1312e0978848761e538ce`、runner=`99a334d358a7aa460d2c69fc83fade61a5e7f6f645300045975077cef49587c6` 的标准本机browser `workspace-measured-geometry-browser-stable/run-20261030-031826-501895098` 为 **16/16 passed**，无skip、身份稳定，回执和附件已核验；2555个文件打开观察帧的最大间隔122.9ms，新Page按键/选择及Actions入口全部通过。此前在catalog修正前主动停止的 `workspace-measured-geometry-browser` 不算当前通过证据，原目录保留。matching release编译中，真实native与托管性能仍待验证。
- `b5fcae70a71c11c23ecc78c169cbcce15b0dea19` 已推送，TypeScript、QA前端构建及refactor通过（768 commands/328 exports/39 events、912模块、4147文件）；dev contract通过。指定workflow的新运行 [40940714805](https://github.com/engcapa/taomni/actions/runs/40940714805) 已启动，下载的selection确认相同source/runner与260次计划执行，无能力缺口。GitHub API把完整SHA作为workflow `ref` 返回422且没有创建运行；改用已核实指向该SHA的当前分支作为workflow ref，`head`仍为完整40位SHA。当前browser/native结果仍待收集，尚未验收。
- 本机matching release构建687.51秒，binary SHA=`aa0582c18009cec73c71d24a2d539e86d8025c6c717f610c0f7acf68d2c5560c`。`workspace-measured-geometry-native-targeted/run-20261030-033908-030602290` 为 **22 passed / 1 failed / 0 skipped**，身份稳定，1433个附件和回执已核验；所有性能点通过，最大帧97ms，HOME深层JSON正文129ms/高亮208ms/max62ms，HOME源码261/404/91ms。026/042真实OS选择及073全部Page入口通过。022的真实choose/cancel均完成，但选择后立即一次性读取路径失败，随后失败HTML已显示精确目标；产品 `browse()` 在OS关闭后异步提交返回值。现在仅对原精确路径表达式增加最多5秒poll，根数量、选中目录、实际文件、取消及reload断言不变；不影响150/1500ms性能门槛，不重建相同源码binary。完整native崩溃组及022修正后的专项待完成，原失败保留。
- 同source/runner的完整native崩溃组 `workspace-measured-geometry-native-crash/run-20261030-034555-627009028` **9/9 passed**；随后单独执行修正的022，`workspace-picker-publication-native/run-20261030-034933-052596312` **1/1 passed**，原精确路径、choose/cancel、根目录、读取实际文件及reload全部通过。两个执行均身份稳定、无skip，292/13个附件与回执已核验。只重跑改变的用例且复用相同matching release；原22/1不改写，不能把本机通过外推为GitHub当前SHA通过。

- `b5fcae70` 的 GitHub [40940714805](https://github.com/engcapa/taomni/actions/runs/40940714805) 已结束，原始执行为 **251 passed / 9 failed / 0 skipped**、260次。剩余包括macOS browser 064/073、macOS native 064及Linux HOME深层JSON的150ms长帧，Linux 077旧End滚动重试覆盖新Home请求、024-03终端移动后结果行缺失、macOS061在整组动作结束前SDK已到五秒，以及Windows054端口观察PowerShell超时和062 fixture编译超过60秒。失败原件保留，新源码仍须重新托管验证。
- 目录树旧请求竞态已有真实挂载的改前失败；滚动测量重试现在随新导航、手动wheel/pointer输入或卸载取消。光标/折叠快照改为直接通知独立布局保存调度器，继续250ms合并、退出立即保存和workspace切换清理；不再为保存通知重画编辑器。菜单列表、Search Everywhere和Keymap消费者共享同一份prepared evaluation，Actions注册/选择变化只发布菜单投影；命令port与派发仍即时，菜单通知继续让出真实paint，卸载取消。改前回归捕获owner额外渲染，修后StrictMode/命令替换/旧evaluation拒绝/只读和选择变化等21项定向支持回归通过。
- 中间源码 `b31a6734ab467c5948603bb1dd24f206a8ed36bc8ae40b8dfae9e2bb28284cb8` 的本机 `workspace-projection-browser/run-20261030-042129-141641026` **16/16 passed**、无skip、输入稳定，回执及全部附件已核验。完整适用browser崩溃组、064/066/068/069/070/073/077/078均通过，2554个原始观察帧最大105.4ms；后续命令context通知的进一步隔离尚需新组合回归，不将该结果外推为新源码通过。
- Windows重启检查现直接读取IPv4/IPv6原生IP Helper listener表，保留真实PID、占用等待和观察错误失败，不再启动慢PowerShell/CIM查询。Windows构建job增加原生表及进程清理合同。SDK fixture的独立rustc准备保留有界180秒及超时诊断；产品SDK五秒、动作1500ms和全帧150ms预算均不变。20项工具/真实独立SDK子进程合同通过，实际Windows边界留给新workflow验证。

## 当前非性能 follow-up

以下按最终组合源码验收；历史通过不能替代新源码证据。Windows监听器所有权修复已在40980594603真实原生030通过；最终组合继续保留该回归。

| 事项 | 当前状态与关闭条件 |
| --- | --- |
| SDK/LSP生命周期 | 已实现；本机及cf1729托管macOS061–063真实SDK场景通过；最终组合三平台保留真实错误、手动刷新、取消/重试、迟到响应及文档队列顺序 |
| 多root与系统选择器 | 已实现；最终三平台确认第二/第三root、重复选择、取消、跨工作区迟到结果和成功后展开Project |
| 编辑器与崩溃保留契约 | 先前组合392项支持测试通过；最终同SHA验证dirty/save、undo/redo、恢复、分屏、剪贴板、树焦点、Page导航、隐藏面板及完整适用crash组 |
| 关闭/重载与树指针竞态 | bc75托管072与074功能断言已在三平台通过；074还有Linux长帧，不能归为功能问题已完全验收；最终组合继续保留 |
| 设置与分屏就绪 | Code Style打开崩溃已修复且新增区分回归，当前产品源码真实browser修后通过；TREE-01增加真实第二编辑器就绪及正文断言，最终三平台复验 |
| macOS应用菜单生命周期 | cf1729托管080已通过真实enabled/checked、保存、关闭、勾选项及reload后About回调；最终组合保留该原生回归 |
| 当前分支全量回归 | 相关集全绿后，以当前分支同一SHA使用指定workflow的scope=all验证三平台browser/native；Linux选择ubuntu-22.04-x11以保留正式比较可复用的原始release，核对全部执行及构建身份 |
| 外部缺口与证据文档 | clickhousecrud源码未提供的TC-IDE-C6-06按既有约定单列；整理最终同SHA回执、截图、构建身份及遗留项，不计缺口为通过 |

HOME混合fixture与用户要求的本机测试产物清理已完成，不列为剩余开发项。

## 当前分支与历史交接入口

- 仓库 `/data-raw-ssd/code-src/person/taomni`，分支 `docs/workspace-platform-redesign`。恢复后已推送至 `80f32c3a174d03328b3c9c220e587cbfc10d2c61` 并运行上述GitHub相关集；后续修正及验证记录见“本轮恢复记录”。`dc33439e`及以下暂停快照属于历史交接状态，不代表当前分支未推送或已验收。
- 锚定目标：现代、简洁、易用；尽量匹配[设计](./workspace-platform-redesign-design.md)和[原型](./workspace-platform-redesign-prototype.html)，保留 main 的能力。当前重点是文件打开/切换的停顿，不能用局部快了替代整体性能验收。
- 用户提供的[HOME 性能分析](../docs-issue/workspace-home-file-open-latency-design.md)是修复依据；[实现报告](./workspace-platform-redesign-implementation-report.md)含早先 UI、崩溃及正式性能证据。本节更新于两份文档的早期状态之后。
- 分支历史已吸收远程 Compact/HOME 目录加载修复。本轮按用户最新要求保留当前分支作为开发与验收对象；正式相对性能比较单独固定基线SHA。

## 用户手工测试反馈与验收重点

| 用户实际反馈 | 后续必须验证的结果 |
| --- | --- |
| 添加/打开目录后，打开文件会显示 SDK 加载数秒到十几秒，期间阻塞 | 目录先作为普通 file explorer 使用；文件先显示、可输入，SDK/LSP/项目识别异步；无代码需求时不自动探测 |
| QA release 打开600多行 JSON 约2–3秒且卡住 | 同时验证普通704行公开 JSON 与接近用户负载的长行 JSON，不只测试小文件 |
| 用户指定 `/home/zhyhang/credentials.json` 帮助复现 | 已只统计196,289 bytes、693行、最长行5,148字符；不读写其正文，不把字段或内容放进 fixture/报告，使用公开合成数据 |
| 后续手测发现 HTML、text 以及任意类型/大小的文件都有停顿；多个 tab 切换也一样 | 覆盖首次文件、第二个新文件、已打开 tab 来回切换、dirty、Home 返回、重开恢复，不能只测 JSON 或第一次打开 |
| 使用“最新编译 QA 进制”在 `$HOME` 打开文件和切 tab 仍约5秒，要求达到 VS Code 类编辑器的打开速度 | 这仍是未关闭的用户反馈；不能归咎于用户用了旧进制。自动化的隔离配置与用户实际 QA 配置可能不同，需核对真实路径、目录规模、设置和匹配二进制身份 |
| 添加 folder 后要默认显示并展开目录树 | 每次成功添加、第二/第三 root、重复选择、取消、跨工作区迟到结果都要回归；被动切模式不强制改变用户侧栏偏好 |
| HOME/大目录节点曾显示 empty，目录打开拖慢；默认工作区也要完整文件能力 | 保留按可见层级加载、明确 loading/error/retry、普通文件浏览、排序/列表/包平铺及源码 LSP 能力；不要因优化跳过真实目录或缩减功能 |

上述反馈针对多个先后构建。秒级根因已找到并修过，但最新组合源码尚未无注入验收，不能标记用户的5秒问题已解决。当前自动化门槛为正文/高亮1500ms及完整观察期每帧≤165ms（150ms基准加用户允许的10%容差）；同条件相对 main 不退化还要单独验证。按用户最新补充，GitHub真实HOME模拟场景通过可作为HOME性能验收，不要求用户手工复测作为前置。

## 当前正在开发的代码与功能保留范围

| 范围 | 已落地或本次提交的内容 | 尚需完成 |
| --- | --- | --- |
| 后端线程 | 文件读取与 `workspace_execution_model` 的路径解析、扫描移到 blocking worker；后者曾在窗口线程递归 HOME，导致4–6秒冻结 | 用新 release 检查窗口线程不再同步扫描，保留真实错误/取消/重试 |
| 项目/SDK/LSP/Git | 按真实源码需求后台发现；普通 txt/html/json/md 不自动递归执行发现；已识别项目的普通文档保留 Run；HOME/大非项目根按活动文件祖先找最近Git仓库，保留并发上限、真实Git状态和手动刷新 | 首次paint后自动启动仍需组合验收；HOME Git本机079已通过，GitHub三平台matching release待验证 |
| 编辑器 | 常驻 EditorView、按文件缓存 EditorState、快读取合并提交、慢读取恢复、dirty/undo/光标/滚动/折叠隔离 | 继续定位冷挂载渲染/布局；不能通过丢弃历史、关闭高亮或破坏拆屏来提速 |
| 本次焦点修正 | `hooks/useWorkspaceTreeOpening.ts` 将树打开后的焦点放到编辑器测量帧，重新校验请求/epoch/pane/file/input焦点，去重并取消过期帧；新增8项支持测试 | 无注入 native/browser 真实打开后自动聚焦、直接输入、迟到端口及切换竞态仍待执行 |
| 本次冷初始化 | 撤回 detached EditorView 构造，恢复真实 parent 初始化；`host/useEditorDecorations.ts` 跳过初始相同 stripe sources 的空更新 | 匹配 release 尚未运行本轮专项，不能声称收益成立 |
| 外观/样式 | 外观扩展有界缓存，style-mod ESM/CJS 仅在CSS变化时改STYLE；保留全局字体大小/字体/主题、重附加与多pane | 本次组合源码仍需全局外观和多pane回归 |
| 文件树 | >80逻辑行虚拟化，overscan上下各8行；完整逻辑键盘顺序、Git计数索引、自然排序 | 本次修正 sticky header/真实padding/末行半像素裁切，保留严格077几何断言，需跨WebView确认 |
| 跨平台模块 | 将 `ProjectTreeRows.tsx` 改为 `projectTreeRendering.tsx`，消除其与 `projectTreeRows.ts` 在大小写不敏感系统中的冲突 | 重新证明Windows/macOS可构建、App可加载；可补通用同stem大小写冲突静态检查，防止再次漏到CI |
| 用例调整 | 077新增真实打开后的 `.cm-content:focus`；040对原有300ms合并写入增加最多5秒条件轮询，原断言不删 | 下轮相关集加入 `TC-IDE-TREEOPEN-01-project-tree-open-focus-native`，保留键盘直接输入、undo及磁盘SHA |

此前 UI 实现仍需作为最终功能回归范围：全局与session大预览、Sessions无welcome/旧小预览、分区正确路由、广播选择、很多session tab的滚动/过滤、工具栏过滤与收纳、语音项移除、所有视图顶部窗口拖动、系统目录选择器、工作区terminal右键、单一Git按钮、IDE工具区分隔、工作区文件/session恢复、文件树列表/排序/包平铺以及Agents Crew“开发中”按钮。不要把这些已有实现当作本次组合源码已全量验证；按[用例规范](./workspace-platform-redesign-testcases.md)和实现报告追踪，发现缺失则补用例。

## 已采取的性能对比与诊断措施

1. **正式比较使用同机原生 release 四轮交错**：`main-1 → candidate-1 → main-2 → candidate-2`。固定main与candidate的完整SHA、相同WebView/1440×900/DPR/数据集/观察器，保留原始二进制及producer identity，不重写identity、不以重新构建版本替换已验收candidate。
2. 负载包含24个真实PTY、会话创建/切换/回显、完整2MiB终端输出、3,097文件的目录浏览/冷暖展开/滚动、24×64KiB文件、1MiB编辑器及每轮400正式输入键；核验正文、输出序号/字节/SHA、dirty/save/undo/redo、CPU/PSS与关闭后进程清理。
3. 比较保存所有样本、p50/p95、每轮分布与慢尾；延迟门槛为原有main p95×1.15加噪声（至少20ms，回显至少30ms，并纳入两次main差异）。资源门槛见 `workspace_perf/analyze.py`，不得临时抬高；输入仍受150ms预算约束。
4. 历史正式比较 [40703223277](https://github.com/engcapa/taomni/actions/runs/40703223277) 已执行且**失败**，candidate=`f6f8d27681e5dae552b03c6d784a074844ee52ad`、baseline=`a57437927b62d6036a6d473eddccc053a4b4c0e8`。会话切换54→402ms、冷工作区951→1540ms、树滚动46→266ms、24终端空闲CPU 0.331→2.139核等有退化；这批历史结果不代表当前候选，最终必须重新正式比较。
5. 历史隔离CSS实验确认圆角overflow裁剪造成WebKit高CPU；最终以四角装饰保留9px圆角/边框/阴影，避开整层裁剪破坏viewport弹窗。对照诊断有改善，仍须以新组合源码正式性能验证确认。
6. 当前本机专项使用独立Xvfb/QA配置。真实输入起点为最早pointerdown/mousedown，不从异步读取完成或dblclick之后起算；保留每帧、正文、高亮、EditorView复用与存储写入耗时，仅记录key/长度、不保存值。
7. 原生栈/系统调用证明HOME扫描的秒级根因；JSC采样、转发DOM计时分别定位冗余scroll写入、首次focus、重复STYLE、语言/补全重配置和React渲染。干预诊断与无注入标准用例分开；“保留失败继续收样”的脚本末尾主动失败，不拿它通过验收。
8. 临时size containment、CSSOM插入及detached构造未得到有效整体收益，未保留为性能结论。最近诊断warm切换42–62ms只是定位样本；不是与main匹配的正式比较，也不能抵销冷打开失败或用户仍5秒的反馈。

正式 workflow 为 [qa-workspace-performance.yml](../.github/workflows/qa-workspace-performance.yml)，实现入口在 `.agents/skills/qa-ui-auto/scripts/workspace_perf/`。只在当前分支同SHA三平台全量无未接受失败后启动，并记录固定比较基线SHA。若workflow尚未出现在默认分支，按现有push入口把同一已验收SHA推到 `qa/workspace-performance/<functional-run-id>`，不能为绕过gate新造一个源码提交。当前gate仅明确白名单三条RDP性能例外；如出现用户允许单列的其他RDP/VNC性能case，先精确扩展例外合同，不能把功能/基础设施失败放入例外。

## 暂停时的真实验证结果

| 输入/证据 | 实际结果与限制 |
| --- | --- |
| GitHub `40840344631`，`9d70ce07` | 64次执行：55 passed / 9 failed；全为150ms长帧失败；完整适用崩溃组17次通过。旧源码结果，不能替代本次 |
| GitHub [40854331480](https://github.com/engcapa/taomni/actions/runs/40854331480)，`dc33439e` | 已结束，workflow failure。计划244次适用执行；实际164次：67 passed / 97 failed、用例无skip，另80次Windows/macOS native因构建失败未执行 |
| 上述run分组 | Linux browser 34 passed / 7 failed；Linux native 33 passed / 8 failed；Windows与macOS browser各0 passed / 41 failed，均为App初始模块冲突。不能把分片job success当作用例通过 |
| 上述run失败分类 | Linux browser：040异步存储假设、077末行裁切、064/066/068/070/073长帧；Linux native：077裁切、064/065/066/067/068/073/075长帧（165–203ms）。完整三平台崩溃组未全绿 |
| 上述run证据核验 | 已下载6份browser及4份Linux native原始receipt；签名、source稳定性、2,418个发布附件的大小/SHA均通过。source=`efcd353a2d596c23c3658dc8e8db1809d7bee915abd17eb9bbc9bb344bf84600`。失败原件保留在 `qa-ui-auto-report/github-40854331480/` |
| 本机 `workspace-local-cold-init-candidate/run-20261029-175907-811321107` | 同dc33439e matching QA release，7条中1 passed / 6 failed；065/067/073/074/075最长帧229/227/233/197/223ms；076真实Run/PTY通过；077几何失败 |
| 本次提交支持测试 | `workspace-focus-navigation-unit.log`：7文件33项passed；覆盖本次8项焦点生命周期及真实编辑器/虚拟树/stripe。不是browser/native验收 |
| 本次编译前端与静态 | TypeScript、Vite QA frontend及 `pnpm check:refactor` 已通过；768 commands/328 facade exports/39 events保持，908模块边界、4,125文件大小检查通过；audit gate通过，4个既有orphan未增加 |
| 本次077 dry-run | 只证明native语法/verb支持，不含执行receipt，不能算真实用例通过 |
| 本次匹配QA release | `workspace-deferred-focus-qa-release` 已按暂停要求在Rust编译阶段停止；前端构建及检查通过，新release未构建完成，恢复后需续建。尚未运行本次源码的无注入native性能专项，不要使用上一个构建冒充匹配 |

## 恢复后的待办顺序

1. **确认输入与环境**：检查本次提交、远端同分支是否有新提交、`native_build.py --check`及真实QA身份；恢复本任务独立测试桌面，不能操作用户桌面或生产profile。若远端有新代码，先阅读影响，保留现有修复，避免覆盖他人改动。
2. **先解决当前性能与功能失败**：需要本机复现时批量编译一次matching QA release，在独立桌面串行运行受影响专项，观察真实HOME与公开fixture。按用户最新口径，每帧超过165ms则用原始帧和采样拆解剩余主线程工作；正文/高亮/动作1500ms、SDK五秒及输入p95不变，不能靠反复重跑筛慢样本。补查实际配置与自动化隔离配置的差异，继续关闭5秒反馈。
3. **三平台相关集**：推送完整40位SHA，通过 `gh` 调度 `qa-ui-auto-platforms` 的browser/native/release，关闭`workspace_stage_trace`；原72条ID选集加macOS原生080，保留TREEOPEN-01、078/079和完整10 ID `crash-regression`，以本轮selection记录为准。修失败、提交推送、重跑并监控原始case结果，直到全部适用相关执行通过。不要只看workflow/job颜色。
4. **三平台全量**：当前分支同一SHA运行scope=all，检查selection、原始receipt、source/runner/case/build身份与汇总；失败修复后循环。`TC-IDE-C6-06`外部clickhousecrud源码缺口按policy和用户确认单列；只允许RDP/VNC server/client性能失败单列，功能失败必须修。
5. **正式性能及HOME验收**：相同已全量验证SHA与固定main基线运行四轮比较，重点复查上述10项历史退化及sessions/terminal/file explorer；比较失败则修复，产品源码变化后重新取得对应功能证据再比较。记录平台、profile、数据规模和实际二进制身份；按用户补充，GitHub runner真实HOME大型混合fixture的各类文件、连续tab切换与深层路径全部通过，可关闭该HOME性能验收，无需等待用户手工复测。

## 恢复命令与执行约束

- Node22路径 `/data/dev/nodejs.backup-20260707-090544/bin`；pnpm10；`CARGO_BUILD_JOBS=2`，本机测试worker总数≤2、native串行。一般browser/native在GitHub跑；用户后续明确授权本机隔离QA release仅用于workspace性能复现。
- GitHub用已登录的 `gh`；外网命令加 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://10.1.0.80:3228`。workflow `head`一定用40位SHA；曾错误传短SHA导致checkout失败，不要重复。
- 系统工具此前已下载并解包到 `qa-ui-auto-report/_local/qa-tools/usr/bin`，无需sudo；`-lgbm`已可解析，没有待用户执行的apt安装要求。重建环境先检查现有工具，不直接重复apt或下载。
- QA二进制 `src-tauri/target/qa-ui-auto/release/taomni`，身份文件为邻接的 `taomni.qa-identity.json`；本机配置 `_local/workspace-latency-native.yaml`，驱动4544/4545。自动化只用其独立profile/公开fixture，不触碰生产 `/usr/bin/taomni`、生产配置/密码及用户手测QA profile。用户先前要求的QA存储清理已完成，不自动再次清空。
- 独立桌面为 `DISPLAY=:190`、1440×900×24。恢复时按owned job状态重启Xvfb及 `dbus-run-session -- metacity --sm-disable --no-composite`；`xdotool`只对该DISPLAY使用。长任务使用 `background_job.py`，不要把进程留在前台工具调用里。
- 磁盘暂停前约95%、14GiB可用。超过95%只清理本repo可重建临时文件，保留失败报告、唯一原始证据及Cargo增量缓存，不执行cargo clean。

```bash
# 设置PATH/PYTHONPATH后先检查；返回1表示需构建，不是已编译通过。
PATH=/data/dev/nodejs.backup-20260707-090544/bin:$PATH \
  python3 .agents/skills/qa-ui-auto/scripts/native_build.py --check

# 构建须通过background_job启动，CARGO_BUILD_JOBS=2；完成后再串行启动专项。
python3 .agents/skills/qa-ui-auto/scripts/background_job.py start \
  --name workspace-resume-qa-release --log qa-ui-auto-report/_local/workspace-resume-qa-release.log \
  --env PATH=/data/dev/nodejs.backup-20260707-090544/bin:$PATH --env CARGO_BUILD_JOBS=2 \
  -- python3 .agents/skills/qa-ui-auto/scripts/native_build.py --release
```

本机下一轮专项参数：`--mode native --config qa-ui-auto-report/_local/workspace-latency-native.yaml --filter TC-WS-065,TC-WS-067,TC-WS-073,TC-WS-074,TC-WS-075,TC-WS-076,TC-WS-077 --workers 1 --keep-runs 0 --require-pass`，通过background job传入 `DISPLAY=:190`、`PYTHONPATH=.agents/skills/qa-ui-auto/scripts` 及工具PATH。使用新的report目录，不覆盖原始失败。

本节 `_local/` 均指 `qa-ui-auto-report/_local/`。历史托管65条ID及244次计划保存在 `_local/workspace-virtual-hosted-case-ids.txt`、`_local/workspace-virtual-hosted-plan.json`；本轮已扩为70 ID，保存在 `_local/workspace-resumed-hosted-case-ids.txt`，含TREEOPEN-01、078、079和受影响剪贴板入口，dispatch前重新plan；若临时目录已清理，从40854331480的selection artifact重建。GitHub参数保持 `scope=selected`、三平台、browser/native、`native_release=true`、`browser_workers=1`、`shards=auto`、`publish_issues=false`。全量与四轮性能均不能用该selected计划替代。

关键本机原件：`_local/workspace-profiler-baseline/combined-native-stack-02.txt`及04/06/08为秒级扫描栈；`workspace-cold-init-diagnostic/run-20261029-180422-204114234/`为转发诊断，077中 `diagnostic-focus-geometry.json`有700.5/700px原始几何；`workspace-deferred-focus-hypothesis/run-20261029-181431-841227501/`仅是假设验证。`_local/profile_workspace_*.py`均为ignored临时诊断，不是标准runner或产品依赖。

## 暂停资源

本次提交前已停止本任务 `workspace-deferred-focus-qa-release`（PID843548，Rust编译中断）、`workspace-qa-wm`（PID770027）及 `workspace-qa-xvfb`（PID769813），保留增量产物和所有失败报告。没有停止生产应用或用户手测实例。GitHub 40854331480已自行结束为failure，未派发新运行。

暂停前另核对040/077的全部verification checkpoint与实际步骤索引/期望一致；这是静态一致性检查，不是运行时通过。构建helper按既有策略在编译开始时移除了旧 `taomni.qa-identity.json`，成功后才会重写；暂停时该文件确实不存在。当前没有可据以宣称“性能修复完成”的本次源码native报告。恢复后先续建matching release再运行，不手工补写identity；不要因为旧路径下仍有可执行文件就直接认定已包含本次修正。

以下保留开发历史与原失败，用于追溯，不作为当前已完成清单。

## 目标与保留行为

- 空工作区、添加目录、浏览 txt/log/csv/json/Markdown 等普通文件时，不自动启动 SDK 注册表解析、版本探测或语言服务发现。用户主动打开 SDK 对话框和刷新仍可解析当前目录。
- 源码先读取、显示和编辑，SDK/语言服务在后台初始化。重开正在关闭的文件仍先等待原有资源清理，清理完成后不再等待 provider；保留最新 dirty buffer 和 didClose/didOpen 顺序。
- 每次成功添加目录都显示当前工作区的 Project 树并展开目标 root，包括第二个目录和重复选择已有目录。取消、被动导航和迟到的其他工作区操作保留当前侧栏偏好。
- 保留语言服务的文档队列、增量同步、诊断作用域、重启、Java bundles 配置、SDK 绑定、错误、手动刷新与 watcher 生命周期。不改变 IPC 名称、持久化格式、原有 5 秒 SDK 超时或缓存 TTL。

## 实现边界

`useWorkspaceServerDiscovery` 单独拥有自动发现、配置与迟到响应失效。产品 runtime 使用已有扩展名分类器，从真实打开的源码 buffer 推导需求；Project 树的历史 `languagePanelOpen` 开关不是语言服务需求。

`useWorkspaceSdkResolution` 按源码需求或显式对话框解析 SDK，以 root 定义而非临时数组引用识别变化，并拒绝取消、隐藏、卸载后的迟到结果。未检测时显示中性 SDK 状态；真实版本命令的 `installation.lastError` 可见。

后端 `sdk/resolution_cache` 合并同 root 的并发解析，不同 root 独立。注册表修订在解析期间变化时重新解析，错误和既有缓存时效保持原语义；取消会释放该 root 的等待锁。Weak owner 表不永久保留所有访问目录的锁。

`workspaceFolderReveal` 是明确成功操作的显示边界；平台 Add Folder 与旧编辑器 Add Root 均接入。回调保持稳定，避免通过命令注册引发重复渲染。Project 不因单纯切换文件、返回模式或恢复旧工作区而被强制展开。

40759974223 的 browser 失败揭示显示边界最初错误地使用标签命令路由 ID，实际编辑器 UI 使用持久化实例 ID。现通过 `workspaceEditorInstanceId` 复用真实 owner，保留导入工作区的既有实例 ID 和默认 `platform:` 格式；添加两个测试，直接读取传给生产编辑器的实例 ID，改前均失败、改后均通过。已有 TC-WS-060 的第二/第三 root、重复选择、取消与切换断言全部保留。

同轮 TC-WS-039 的原始几何记录中，Documentation 可见但宽度为 1px；随后的失败截图已恢复正常，符合旧 `useEffect` 再调度一帧恢复宽度的行为。提取 `useToolWindowPanelVisibility`，用户显示/隐藏操作在 layout effect 中同步真实 panel 尺寸；库内部 ResizeObserver 的延迟发布保持不变。CJS/ESM 真实组件新增连续三次显示/隐藏测试，改前均失败，修正后与原有隐藏恢复、observer 清理和嵌套分屏回归一并通过。不延长用例超时、不增加等待、不修改几何下限。

## 改前证据

产品 source `6294904349ed0130a2eeccbee4214e1f62d8b14523ec29657248581bbcb73b3c`：

- [40746813409](https://github.com/engcapa/taomni/actions/runs/40746813409)：17 passed / 5 failed。普通文件场景仍触发发现、第二 root 未显示 Project，SDK exit-1 的实际错误正文未显示。原始回执与汇总已独立核验。
- [40749400862](https://github.com/engcapa/taomni/actions/runs/40749400862)：16 passed / 1 failed。Java 打开 653.8ms；编辑 1540.9ms 超过既定 1500ms。同项目出现四个并发真实 SDK 版本进程。DOM 已含预期编辑内容，这不能单独证明数秒主线程冻结。
- [40743957940](https://github.com/engcapa/taomni/actions/runs/40743957940)：全量 2115 passed / 3 failed。macOS 慢 LSP 与 RDP 剪贴板为功能失败，不能套用性能例外；RDP 性能 p95 90.153292ms 超过 65ms，按用户授权单列。

## 验证

本机只运行单测与静态检查，没有运行 browser/native UI 用例，并发测试 worker 不超过 2。

- 相关 hook、SDK UI、文件操作、资源恢复及真实编辑器生命周期：7 文件 / 77 tests passed。
- 目录对话框、共享代码编辑器与侧栏：3 文件 / 16 tests passed。
- Rust SDK：37 passed，包含真实 SDK 子进程的并发合并、不同 root、迟到注册表更新、失败 TTL 重试、取消重试五项合同。
- SDK 原生观察工具：7 tests passed，拒绝把多个真实版本进程当成一次共享后台探测。
- TypeScript 与 refactor 合同通过；提取模块不超过 800 行，未改变公共命令、事件及 facade 导出。
- 托管失败后追加的实例 ID/绘制前布局修复：5 文件 / 35 tests passed，包括真实编辑器生命周期 10 项、真实 panel 库 CJS/ESM 14 项。新增测试已在修正前复现，原有几何与崩溃断言保持。

托管验收集合包括 `TC-WS-059` 至 `063`、`TC-WS-043`、文件打开/保存/恢复与 LSP 保留场景，以及完整 10 ID `crash-regression`。059 覆盖普通文件保存重开与显式 SDK 刷新；060 覆盖多 root、重复选择、取消及侧栏状态；061/062/063 使用真实待完成 SDK 子进程和真实转发 IPC，验证编辑、模式切换、普通文件打开、失败正文、迟到 LSP、dirty 内容及磁盘 SHA。打开、清空、切换保留 1500ms；逐键测量规则和原始失败见下。正式结果在当前源码的 GitHub 运行完成后填写，旧源码通过记录不替代本轮验收。

## 原生输入测量纠正（2026-10-29）

run `40759974223` Linux Java 整段填充耗时 1894.9ms，run `40762986849` 同路径 1542.4ms，旧 1500ms 整段断言均失败。驱动每字符有固定 20ms pause，前者完整输入约 1.265s；后者保留的 25 个 keydown → input 样本为 1–3ms。最后一次原始 input 曾显示两个右花括号，但两次最终失败 HTML 都是正确的 `public class Main { int value = 7; }`，这是 CodeMirror 接管前的 DOM 瞬态，不能据此声称产品破坏配对状态。真实生产 Host 的同步/迟到 controlled echo 两条组件回归均通过。

因此不把整段打字耗时当单次 UI 响应，也不把修正测量后的通过称为产品加速。现在保留完整原文、原来的逐字键盘输入和 20ms pause；每批最多八个真实 paced keys，保留 1500ms 请求预算；每个 keydown 到下一帧进一步限 150ms。每帧检查当时所有已观察键对应的 canonical document 前缀/caret，最终 DOM 与原文完全相等。总打字耗时、每批请求、每键原始事件/帧和 SDK 等待状态全部保留。每批及后续切换仍须发生在同一真实 SDK 子进程未完成、原有五秒超时之前。原失败报告保留，不重写为通过。

另发现 macOS 原生 `fill` 把 Ctrl+A 当全选，导致 `TC-WS-059` 将新文本接在旧文档后。原生 contenteditable 输入职责已提取到 `native_contenteditable.py`，改用平台 `Mod+A`（macOS Cmd+A）；不改产品快捷键、不用 JS setter、不中途修补文件文本。新增工具回归改前失败、改后通过，原用例的完整文本和磁盘哈希断言保留。

macOS 慢 LSP 诊断 run `40758688130` 已完成 17 passed / 0 failed，330 个发布附件 SHA 及回执已核验。真子进程采样确认 initialize 被持有后仍能打开普通文件、切换工作区并释放，随后出现 didOpen；该次只读诊断通过不能覆盖更早全量中的失败，最终候选仍需运行原用例。

## 逐字观察往返与 Backspace 修正

`40768691984` Linux Java 的 36 字符源文本在输入第 34 个字符后失败：完整逐字观察已耗时 4190.29ms，SDK 第一条 started 至最后 waiting 约 4982ms。34 个已记录键的 keydown → frame p95 为 37ms、max 为 81ms；失败仍保留，未输入的两个字符不算通过。每字符一次输入、一次帧读取和一次 IPC 读取造成约百次 WebDriver 往返，消耗真实子进程的五秒寿命。现在仅将相同 20ms paced input 合为每批最多八键，减少观察往返；36 字符、150ms 逐键帧上限、1500ms 每批请求上限、同一个真实子进程/IPC pending 和五秒生产超时全部保留。若多个键共享一帧，必须检查那一帧已观察到的完整前缀/caret，不丢弃任一键或慢帧。新增工具合同覆盖丢键/乱序、错误前缀、缺帧、慢帧、慢批次和 SDK 已结束。

同 run 的 macOS `TC-WS-062/063` 在清空时失败。原始 `editor-input-failure.json` 显示 Cmd+A 已正确选全文，但接下来的 W3C `U+E003` 被 QA 桥原样作为字符插入，最终 HTML 为一个私用区字符。这是自动化桥缺少 Backspace 解码。把既有键映射移到其键盘 owner 并补齐该项；真实 CodeMirror 的“选全文后删除”和“删除前一字符”组件测试在修复前均失败，修复后与既有表单、按钮默认行为共 15/15 组件测试通过。没有修改生产编辑器输入或采用 JS 文档 setter。

RDP 修复定向 run `40767562150` 已完成 21/21 passed（macOS browser 7、native 14），原始回执和 382 个发布附件 SHA 已独立核验，包含原 `TC-RDPJ-02`、新增同标记迟到发布、rich/files/policy 及完整适用崩溃组。该修复提交的证据不替代最终组合源码的三平台相关集和全量。

本轮工具合同 33/33 通过，TypeScript、Rust formatting、`pnpm check:refactor` 和 `audit --gate` 通过；本机没有运行 browser/native UI。新工具及 QA 桥组合仍需匹配源码的托管相关集、完整崩溃组、全量与正式性能对照。

## 剩余 macOS 响应时间诊断

新增 JSON 改前 run `40782708587` 已捕获冷打开的真实慢帧：Linux browser
214.6ms、macOS browser 157.8ms、macOS native 267ms。内容与高亮在 1500ms 内
出现，但不能据此忽略用户可感知的卡顿。为定位渲染/布局开销，Chromium 另保留
固定 1000µs 间隔的 CPU 采样，失败后也保存；采样不可用明确记录，不取代精确
文档、每帧预算、原生 I/O 和保存断言。改前/改后对照须使用相同观察工具。

用户另报告本机 QA release 首次打开约 600 多行 JSON 时有 2–3 秒阻塞。
新增 `TC-WS-064/065` 使用完全公开、无凭据的 704 行 JSON：64 在 browser/native
中保留冷打开、切回标签、Home 返回的精确文档与语法高亮首帧（1500ms），并对开始
至高亮后 1 秒的每一帧间隔限制 150ms；65 增加真实原生逐键输入（32 键、p95
150ms）、保存、关闭重开和磁盘 SHA。两者均断言不自动调用 SDK/LSP 探测。
先在 GitHub 对改前产品采样，再依据原始耗时定位；不把新增测试或工具单测通过
当作产品问题已经解决。本机不启动 browser/native 用例。

run `40773829621` 的 macOS `TC-WS-062` 已正确清空并输入完整源码；返回工作区为 1458.41ms，接着打开普通文件为 1579.30ms，失败截图已含正确 notes.txt。现有记录无法区分原生 WebDriver 准备/往返、真实文件读取与绘制，不将其归咎于产品或以重跑通过解释。补充 `sdk-action-trace.json`：原始 HTTP 方法/路径/耗时（不含 payload）、真实 pointer/click 时间、下一帧及 canonical/DOM 内容发表。原生转发观察器在独立 `fileReads` 中记录真实读文件 callback 时间，不改变 SDK/LSP counts、不读取源码响应。观察器退出时恢复原请求 owner、取消全部帧和监听器；既有动作、完整字符、1500/150ms 和五秒生产超时不变。

同 run 的 macOS `TC-WS-061` 五个动作及其真实 pending 检查均通过（打开普通文件 1339.67ms），失败发生于无新用户动作之间的第二次最终观察。现在直接保留最后动作结束后已验证的 pending 快照；启动握手成功后也复用同一快照，减少两个重复的 WebDriver 观察请求。没有删除任何交互后的校验；原始 5 秒失败仍保留。正式性能仍须匹配四轮实测。

## 原生文件读取不占用调用线程

四个读文件 IPC 原来使用同步 Tauri command，路径解析、磁盘读取、编码检测和
SHA 计算会在调用线程执行。现在由独立 async 适配器交给 blocking worker；慢文件
不串行阻塞其他读取。核心读取函数、IPC 名称/参数、内容/编码/BOM/hash/metadata、
大小限制、路径逃逸检查与错误保持原契约，后台失败明确返回错误。

这是执行线程调整，不新增用户操作。保留 `TC-WS-064/065` 的真实树打开、切换、
恢复、输入与磁盘 SHA，及既有 `TC-WS-040/042/043` 的文件浏览回归和
`TC-IDE-C0-01` 的编码/磁盘保存回归。
本机 4 项新增 worker 单测与 14 项既有编码/读写单测通过，包括持有慢读取时
调用 executor 与另一读取继续推进、UTF-16/BOM、错误与 worker panic。
CI 的 root Rust contract 同时执行这组测试。原生三平台与完整崩溃组仍须用包含
本次产品改动的 QA release 验证；不能据此认定渲染慢帧已解决。

## JSON 冷打开的渲染开销

同一改前源码的 Linux 定向 `40784926015` 为 16 passed / 2 failed，原始回执与
附件 SHA 已核验。JSON browser 的首帧为 197.8ms，内容首次出现前另有 251.3ms
慢帧；原生首帧为 191ms。CPU 原样采样显示同步 React 渲染/提交占用约 665.6ms，
其中 Lucide 的 `createElement` 调用约 114.6ms。采样与帧报告保留，不能将这些
数值外推为未插桩的生产耗时。

工作区常驻的树、面包屑、工具栏、编辑器和 dock 改用共享的 memo 图标组件：
buffer/selection 更新时复用 props 未变化的 SVG 子树，图标 props、主题 context
和 ref 仍按 React 语义更新。这不改变操作、可达性或工具内容挂载生命周期。
`TC-WS-064/065` 与完整崩溃组继续验证最终组合，正式性能比较仍待执行。

改前 JSON run `40782708587` 已收齐，49 passed / 8 failed，1,180 附件 SHA
核验一致；七项为真实慢帧，Windows 原生 65 的另一项发生于已完成输入、磁盘
SHA 和重开末尾文本之后：Mod+End 使首行离开 CodeMirror 虚拟视口，新用例却
要求首行 DOM 存在。现在只读实际文档首行，仍要求精确 `{`；不改变滚动、输入、
文件内容、预算或磁盘校验。所有原始失败继续保留。

## 用户文件的大小与长行负载

用户提供本机文件路径后，只读统计得到 196,289 bytes、693 行、最长行 5,148
字符、字符串最大长度 5,125，内容均为 ASCII。未将原文、字段名或字段值写入
测试与报告。此前 `TC-WS-064/065` 的公开 JSON 只有 19,362 字符，不能代表这项
长行负载，原用例继续保留。

新增 `TC-WS-066/067` 使用代码生成的公开数据：693 行、197,472 bytes、最长行
5,151 字符，40 条记录，字符串最大长度 5,125。66 在 browser/native 中验证冷开、
标签切回与 Home 恢复的精确内容和语法高亮，1500ms 打开及每帧 150ms 预算不变；
67 增加原生 32 键输入、完整保存 SHA、关闭重开与首行/末尾内容。普通文件的
SDK/LSP 自动探测必须保持为零。当前新增用例未完成托管执行，不能充当修复证据。

## 编辑器与目录排序的渲染边界

主布局会随编辑器 context 和命令注册发表刷新。为避免输入相同时重复遍历整个
编辑器，在平台 canvas、编辑器桥与公共 `CodeWorkspaceTab` 入口使用 React 默认
`memo` 边界；各组件自身的 store/context 订阅继续交付真实变化，没有自定义
比较器、延迟内容、改变挂载生命周期或取消资源。Project 树仅在目录条目、平铺
文件或排序偏好变化时重排，selection、caret、dirty 更新复用已有顺序。

本机对应真实编辑器生命周期、平台文件桥、Git 同步、Project 树及公共编辑器共
5 文件 / 288 tests passed（最多 2 workers）；TypeScript 与 refactor 合同通过。
这是待托管测量的产品优化，尚不能据单测声称减少慢帧。保留 `TC-WS-064` 至
`067` 和完整崩溃组，并将补充普通 txt/log/csv 冷开及连续标签切换的响应回归。

新增 `TC-WS-068/069`：68 从真实树冷开 txt/log/csv/未知扩展名的普通文本；69
在五个 txt/log/csv/JSON 标签之间连续切换十次，其中包含 193KiB 长行 JSON，
并保留未保存草稿，最后保存、关闭和重开精确内容。两者均覆盖 browser/native。
普通文本没有语法 token，显式使用 `require_highlight: false`；仍检查完整可见
canonical 文档、1500ms 内容预算和从真实操作至内容出现后 1 秒的每帧 150ms
预算。原 JSON 默认高亮断言完全保留。工具 13 项 Python 和 4 项 JS 合同通过，
覆盖纯文本未高亮、错误内容、慢帧、超时、清理与原始失败保留；目录 audit gate
及托管选择计划通过。新用例执行结果仍待 GitHub，不能作为通过证据。

普通文件基线 [40792477689](https://github.com/engcapa/taomni/actions/runs/40792477689)
已在 browser 复现：30 字符 notes.txt 冷开有 159ms 帧间隔，切至 51 字符
service.log 有 171ms 帧间隔；不是仅由大 JSON 触发的问题。新用例的原始失败
保留，native 仍在构建。

另修正主窗口的订阅范围：`useMainLayoutState` 仅订阅实际使用的字段，公共
session import/export hook 和 Welcome 只订阅其 `setStatusMessage` 方法。
此前后两者即使只取一个方法也订阅整个 app store，文件 context、诊断或状态
发表会连带刷新整个窗口。新增真实 MainLayout 回归在改前失败；三处订阅边界
修正后与既有窗口导航、终端保活、主菜单快捷键及 Home 回归共 80 tests passed。
context 和状态仍由原 owner 发表，原消费者继续收到更新，广播开关仍触发 shell
更新；没有调整持久化、快捷键或编辑器挂载生命周期。托管帧验证尚未完成。
状态条消费者与 session import/export 另有 55 tests passed，TypeScript 和
`pnpm check:refactor` 通过；本机只执行这些单测和静态检查。

同一公共路径还存在 `useWorkspaceTabs` 对完整平台工作区数组的订阅，尽管
关联 Git 清理只使用“仍打开的 code 编辑器实例 ID”。现在使用浅比较选择这些
ID，文件选择、目录和 buffer 信息变化由原消费者交付，编辑器关闭或导入实例
ID 变化仍立即清理失去 owner 的 Git 标签。新增隔离测试改前由一次 render
增至四次，改后与两条 Git 清理回归、真实 Git 集成及主布局回归共 67 tests
passed。本轮 `8d4fc91b` 托管验证仍捕获 browser 慢帧（JSON 152–163ms、普通
文件/标签 188–228ms）；订阅调整尚不能作为卡顿通过证据。

## 命令发布与最近记录隔离

`5d280fbf` 的 Linux 同工具验证 `40795232441` 已结束：21 passed / 10 failed，
20 个用例 ID（含完整 10 ID 崩溃组）与 711 个附件 SHA 独立核验一致。browser
冷开/切换慢帧 160–275ms；native 153–276ms。关闭 DOM 快照后仍有真实同步
React 耗时，因此不能将卡顿归因于录制或宣称前述优化已通过。

进一步去掉命令注册时的主窗口 React state 更新。实例命令和 shell shortcut
claims 仍同步写入注册表，快捷键读取原 ref；窗口菜单在打开时读取当前 owner，
macOS 原生菜单直接订阅注册表，隐藏实例发表不重装当前菜单，卸载释放订阅。
关闭的 owner 不再执行残留菜单操作。最近工作区记录移到 Home 内部订阅，仍
保持记录与恢复逻辑，打开文件不再因此刷新所有窗口后代。

两条隔离回归在改前分别捕获命令发布 render 1→2、最近记录主窗口 render 3→4。
修正后主布局、Home 最近记录、主菜单、快捷键桥、编辑器上下文桥共 6 文件 /
95 tests passed；TypeScript 与 refactor 合同通过。这是纯更新边界重构，没有新增
用户流程；保留 `TC-WS-064` 至 `069`、Home 路由 `TC-WS-025/026`、
`TC-IDE-C4-02-split-and-structured-reopen` 与完整崩溃组作为托管行为门禁。
新的帧测量及三平台结果尚未收齐，当前仍未验收。

## 文件激活的协调与定义更新

新增回归在修改前复现三种多余渲染：同目录的 active-file 发布仍重建
`rootFolders`；文件请求完成标记使编辑器额外 render 1→2；仅更新历史 caret、
前进/后退可用性未变仍 render 4→5。文件协调的单测还发现读取旧 React
snapshot 会将已激活的 b.html 发布为 a.txt。

`useWorkspaceCodeDefinition` 拥有平台输入与编辑器输出的适配、最近记录和
持久化；通过发布对象的精确身份识别自身反射，不把保存的 active file 再当成
一次新输入。外部打开请求、新 root、loose files 和恢复身份继续传给编辑器。
平台定义动作提取到 `workspacePlatformCodeActions`，未改变根目录时复用原
列表，仍即时保存当前文件和原有存储格式。没有暂停或延迟用户选择。

`useWorkspaceHostFiles` 用 ref 记录内部协调状态，队列完成后直接从同一
buffer owner 的最新状态发布结果并协调 canvas，不额外刷新整个编辑器。
保留串行队列、迟到请求取消、pending-close、dirty 恢复和 provider 同步；
canvas 仍在真实文件就绪后执行，并保留独立 editor split。导航历史仅在按钮
可用性改变时刷新 React，caret/history 本身仍同步更新。

本机 8 文件 / 56 tests passed，包含真实 CodeMirror 的 dirty/save/undo、
split/grid/single、关闭后重开、外部定义和快速 supersede。新增
`TC-WS-070` 覆盖五行 HTML、704 行文本、小文本的三次冷开和六次标签激活；
HTML 保留高亮、正文精确相等、零自动 SDK/LSP、1500ms 内容和每帧150ms
断言。064–069、025/026、C4-02 与完整 10 ID 崩溃组继续保留。此处只记录
实现和单测结果，托管帧验证及原生 release 仍待新一轮执行。

## 激活时的同步持久化与辅助更新

`33313e03` 的 Linux 托管运行
[40802285035](https://github.com/engcapa/taomni/actions/runs/40802285035)
已完成并独立核验：25 个适用 ID、38 次执行，28 passed / 10 failed；801 个
附件 SHA 与 aggregate 一致，无基础设施错误。完整 10 ID 崩溃专项在 browser
和 native 均通过，但文件激活的性能尚未通过。browser HTML 正文 401.1ms、
最大帧 241.5ms；native HTML 最大帧 178ms。native 普通文本四种冷开和连续
十二次标签激活通过，不代表其他文件或用户本机已经达标。保留全部失败证据。

继续去掉公共激活路径中的重复工作：干净文件的加载、关闭和重复 publication
不重写 dirty 恢复日志；真实编辑、保存、关闭 dirty 文件仍同步更新恢复内容，
写入失败仍在下次 publication 重试。同一树节点重复 click/double-click、同一
canvas 重复聚焦不再写 store 或平台持久化。

编辑器 command port 的 owner 注册和命令执行仍即时完成，菜单 projection、
selection revision 和已捕获 caret/fold/scroll 的持久化通知使用 transition。
命令 dispatch 从实时 store 和 port 读取上下文，避免辅助 UI 尚未 render 时
使用旧文件、选区、只读或 composition 标志。布局退出保存仍直接读取原 ref。
新增改前失败的去重、恢复写入和实时 owner 回归；连同真实 CodeMirror 的
dirty/save/undo、split/grid/single、StrictMode、恢复和 pending save，共
8 文件 / 126 tests passed（本机最多 2 workers）。

生命周期测试的命令发布改为按 runtime ID 保存，匹配生产主窗口；此前隐藏
空 workspace 的晚发布会覆盖测试单个全局变量，现按真实活动 workspace
选择命令，保留所有实际编辑、撤销与保存断言。`TC-WS-070` 保留三次冷开、
六次切换，增加重复点击当前标签和正文聚焦，共 11 次激活测量。正文、HTML
高亮、零自动 SDK/LSP、1500ms 内容和每帧 150ms 预算未放宽。当前实现的
GitHub 性能与完整崩溃回归仍待执行，不能据单测宣称速度达标。


## Home 文件监听与增量目录刷新

`7724ce43` 的 Linux 托管运行
[40805896015](https://github.com/engcapa/taomni/actions/runs/40805896015)
已结束：38 次执行中 31 passed / 7 failed，无基础设施错误；完整崩溃组通过。
失败仍是文件打开/激活长帧（154–199ms），不是性能验收通过证据。

参考 `docs-issue/workspace-home-file-open-latency-design.md`，先处理 P0 监听边界：
OS watcher 注册移入 blocking worker，Home 根只监听直接子项，已展开目录和
已打开文件补充按需监听。普通项目保留递归语义，显式打开的缓存目录/文件仍
可操作。应用自身存储路径在进入异步队列前过滤，显式打开一个内部文件不会
放开其它内部写入。取消 token 和任务身份保护启动/停止重叠时的归属。

外部事件按 200ms 批次刷新已加载的受影响父目录，不 reset 全树；保留其它
目录的列表与行。平铺索引仅在当前显示/过滤需要时更新，迟到响应不能覆盖
新一轮列表。Project 树只接收 dirty 提示，正文和加载变化不重建该输入。
移除初始文档构造中多余的空扩展 EditorState 初始化。

新增 native `TC-WS-071` 将真实 runner Home 与公开的报告目录同时加入，
用真实 host 新建、修改、删除及重建文件，核验树、buffer 与未受影响目录，
通过转发观察器断言没有递归扫描或全树重刷。这个用例负责磁盘/监听契约；
064–070 的真实打开帧预算继续独立保留，完整崩溃组仍是门禁。
本机不执行 browser/native 用例；执行 focused Vitest、真实 notify Rust 测试、
工具单测、TypeScript 与 refactor 合同。EditorView 复用及最终性能验收尚未完成。

## 常驻编辑器、文件状态缓存与读取就绪提交

Home 监听版本 [40811827670](https://github.com/engcapa/taomni/actions/runs/40811827670)
实际执行 35 次，26 passed / 9 failed；无基础设施错误，完整崩溃组通过，真实
Home 外部文件增删改与增量树刷新 `TC-WS-071` 通过。browser 的冷开长行 JSON
仍有 347ms 慢帧；native 首次打开 JSON、HTML、普通文本仍有 163–216ms 慢帧。
保留原始报告，这说明仅修监听没有解决文件打开的固有开销。

按分析 P1 移除普通文件的动态 host key，每个 pane 复用同一 EditorView。
新增独立 `editorStateCache`，最多缓存 24 个文件及 800 万字符；关闭文件、改变
文档路径、切换 workspace/transaction owner、卸载 pane 时释放对应状态。
回切保留选区、折叠、滚动与独立撤销，canonical 文档和共享 history 的所有权
保持不变；用当前只读、换行、字体、诊断、调试等配置重新绑定扩展。相同正文
复用已有 CodeMirror Text，避免回切重新构造全文树。

文档激活结束会释放原 view lease、监听、composition、clipboard generation、
补全和 snippet 请求；旧语义选区 promise、被拒事务 microtask、参数提示清理
均不能修改新文件。最终卸载才销毁实际 EditorView。慢读取显示只读加载遮罩，
保留编辑器实例；读取就绪解除只读并显示正文。

读取请求直接开始，80ms 内返回则先发布 ready buffer 再激活标签，避免
loading→卸载→重建的中间态。超过 80ms 才发布加载状态。较早请求的迟到
结果可以补齐后台标签，但不能夺走后续用户选择。关闭后立即重开仍即时认领
标签，再等待旧清理结束，以免 cleanup 删除已经恢复的 canonical buffer；
LSP 重开继续在后台进行。现有 workspace 测试捕获该竞态后已修复。

本机执行主 workspace 全部 254 条、真实 CodeMirror/IME、快速/慢速读取、
关闭重开、缓存边界与当前设置等 focused 单测；新增实际 View 身份和跨文件
状态回归（6 条），工具 Python 14 条、JS probe 5 条通过。TypeScript、refactor
合同和 catalog gate 通过；本机不跑 browser/native。`TC-WS-070` 在首次打开
之后的十次操作额外断言真实 EditorView 未被替换，正文、高亮、零自动 SDK/LSP、
1500ms 内容及每帧 150ms 门槛均未放宽。保留 `TC-WS-025/026`、064–071，
增加 split/history、跨 pane clipboard、原生 view-state 恢复及关闭重开既有
用例，与完整崩溃组共同在 GitHub 执行；托管性能结果尚待新版本验证。

复查补充：CodeMirror 的 root reconfigure 会保留已有 compartment overrides，
单靠重新传入扩展不能保证缓存文件收到新字体、只读、换行等配置。另一个边界
是旧只读 filter 会拒绝外部 canonical 正文更新。新增两条单测在修前分别捕获
tabSize 仍为 4（期望 8）与正文仍为旧磁盘快照；现在同时重配各 compartment，
并沿用已有 remote transaction 标记同步 canonical 内容。7 条真实 View 回归
包含在另一文件中修改全局外观后回切；CodeMirror/IME/cache 4 文件 88 tests
passed。前一提交用 Node.js 22、2 workers 执行的相关 10 文件 375 tests passed。
`TC-WS-034` 增加先切至普通文本再修改 Settings、回切 README 的字体/主题及
独立撤销断言，覆盖缓存文件的全局外观同步。

## 隐藏工具窗口的构造边界与 Home 历史更新

常驻 View 首轮 [40815182933](https://github.com/engcapa/taomni/actions/runs/40815182933)
执行 39 次，28 passed / 11 failed；完整崩溃组、原生视图状态、拆屏关闭重开和
Home 真实监听通过。native 连续回切与保存重开正文为 57–92ms，但首次打开仍
有 151–231ms 慢帧。设置缓存补修轮
[40816522359](https://github.com/engcapa/taomni/actions/runs/40816522359)
执行 40 次，29 passed / 11 failed。browser 使用单 worker 后首次打开仍有
289–318ms 慢帧，native 为 182–229ms；native 连续切换 48–75ms。两轮均保留
原始失败，不能据此宣称性能达标。后者另有 `TC-WS-034` fixture 选错目录：
该浏览器路径实际有 README.txt，没有 Documents，现改用真实存在的文本文件，
保留字体、主题、dirty 与单字符 undo 断言。

CPU 采样仍显示隐藏工具的 JSX 构造、portal 包装和隐藏 Home 最近记录参与
文件激活。原 KeepAlive 已冻结面板组件，但其父 factory 仍预先构造全部工具
内容。现在将内容构造传入 KeepAlive 内部；隐藏 portal 同样跳过父更新，显示
时使用最新回调和配置。所有工具仍在初始挂载时创建，保留后台 Run/Terminal
句柄、订阅和任务生命周期。工具图标使用固定元素，减少 stripe 的 SVG 重建。
Home 隐藏时冻结 props 并暂停最近 workspace 订阅，返回时同步当前记录，
搜索、所选历史分区和滚动仍由原组件保存。

新增 mounted 回归核验后台句柄、draft、移动 portal、实际卸载、重新显示的
最新回调与 Home 搜索/历史；连同完整 workspace 单测共 7 文件 305 tests
passed（Node 22、最多 2 workers）。`TC-WS-025` 增加隐藏 Home 后保留搜索与
历史分区再进入 workspace 的实际流程。保留并选择 064–071 性能、034 外观、
010/024 工具条、弹层、终端移动原生回归与完整 crash-regression；正文、高亮、
每帧 150ms、1500ms 就绪预算及真实 View 身份不变。本机未运行 browser/native，
本轮托管结果待收集；最终 main 对比和全量门禁仍未完成。

## 面包屑、关闭弹窗与最近记录的订阅边界

`1d63c01b` 的托管运行
[40819080806](https://github.com/engcapa/taomni/actions/runs/40819080806)
browser 实际执行 22 次，17 passed / 5 failed。034 外观、069 连续切换与崩溃
browser 组通过；064/066/068/070 首次打开仍有 251–291ms 长帧。025 在往返
默认和自定义工作区后有两个常驻编辑器，其新增步骤选中了隐藏实例；现在只在
该等待中增加 `:visible`，不改变任何正文、路由、状态保持或错误断言。
native 实际执行 25 次，19 passed / 6 failed；合计 47 次，36 passed / 11 failed。
064 JSON、068 普通文件、069 连续切换通过，但 065/067/066/070 仍有
152–232ms 长帧。另外 007 分屏光标恢复和 024-03 终端移动存在功能失败，
需修复后重新验证，本轮不能宣称性能验收完成。

新的采样显示，隐藏 Home 的子面板直接订阅整个 App store，可以绕过父组件的
memo。最近会话同时订阅整个 Session store。新增 mounted 回归在改前捕获了
一次无关状态发布导致 21 次翻译调用；现在分别选择所需 action 与 session/group
数据，无关文件/状态更新不再重绘历史面板，分组变化仍正常更新。

面包屑路径/图标提取为 memoized `BreadcrumbTrail`，事件通过现有 latest handler
机制读取当前回调；弹窗的 actions getter、请求 generation、清理和键盘导航仍由
原 Breadcrumbs 管理。关闭的导航弹窗保留 owner，但跳过无关正文/光标发布；
每次打开和关闭都渲染，保证异步取消、当前数据、回调以及焦点返回。工具条按钮
同样按实际显示字段 memo，点击、双击及右键都使用当前 handler 和 item。

此轮是保持交互的内部渲染优化，沿用真实耗时用例 064–071，不新增同义 YAML；
回归增加选择 `TC-IDE-NAV-01`、`TC-IDE-PARITY-014-01` 以覆盖面包屑导航、
Structure/Search Everywhere/Recent Files 的关闭再打开，并保留工具条 010/024、
Home 025/026、全局外观034和完整 crash-regression。单测新增旧/新回调、弹窗
焦点、状态订阅与当前按钮数据显示断言；本机只运行单测和静态检查，不运行
browser/native。持久化、后台发现和大型树的剩余方案仍需按实际证据推进，
不得用单测或较小文件行数替代最终同条件 native 性能对比。

本机最终组合回归：14 文件 357 tests passed（Node.js 22、最多 2 workers）；
TypeScript、`pnpm check:refactor`、catalog gate、selected CI plan 全部通过。
新增用例的改前失败和全部修后日志保存在 `qa-ui-auto-report/_local/`，不作为
browser/native 的执行证据；新 SHA 的托管运行仍待执行。

## 慢读取视图恢复与终端移动的竞态回归

托管运行 40819080806 中，007 恢复两个活动文件共耗时 665ms，超过读取占位的
80ms 阈值。常驻编辑器在空占位文档上提前消费了光标/折叠快照，真实正文到达
后仅同步内容，没有重新恢复光标。新增真实 mounted 回归在改前复现光标落在
offset 0，以及 beforeunload 把空文档快照写回的问题。

现在由独立的 `editorViewStateLifecycle` 管理每次文件激活的恢复、延时捕获、
退出捕获与清理；`documentReady` 显式标识正文是否可用。待正文 reconciliation
完成后才消费一次快照，占位文档不能写回持久化或进入 EditorState 缓存。
分屏各自恢复、已有用户操作取消恢复、内容身份不符拒绝恢复、关闭重开、撤销
和延迟滚动语义保持。007 原生用例额外断言在另一分屏编辑后返回主分屏，41行
光标与折叠仍保留，并检查运行时错误。

024-03 的失败证据显示终端已经移回底部、命令有回显，但独立结果行缺失；
移动后 100ms 才执行的尺寸同步会与新输入竞争。将 ResizeObserver 的延时防抖
改为下一帧同步最新几何，连续通知每帧合并一次，销毁取消待处理帧。mounted
回归改前无法在下一帧得到正确 PTY 尺寸，修后通过；真实输出是否修复仍以
托管 024-03 原有的三次独立输出断言为准，不添加输出重试、不删除或放宽断言。
该调度属于内部生命周期修复，复用 024-03、051/056 及现有终端 retained cases。

本机：编辑器/工作区 14 文件 404 tests passed；终端及工具窗口 6 文件 116
passed / 1 既有编译模式条件 skip（生产模式与 QA 镜像分支互斥），最多 2 workers。
本机未执行 browser/native。1500ms 正文/高亮及全观察期每帧150ms预算保持。
下一轮托管覆盖 064–071、007/024-03 等功能与完整 crash-regression，结果待收集。

## 后台元数据持久化与外观读取缓存

托管运行 40823139637（`db4dff9e`）共执行49次：browser 20通过/4失败，
native 19通过/6失败，无跳过。007分屏恢复与024-03三次独立终端输出均通过，
本轮适用的完整崩溃回归通过。失败全部为首次打开的全观察期150ms帧预算：
browser 153.8–173.3ms，native 191–231ms；仍未达验收，不刷绿、不放宽预算。

CPU采样与源码继续发现激活调用栈上的同步存储，以及外观初始值在每次渲染
重复读取/规范化。真实store单测复现一组文件操作5次同步写入；mounted外观
单测复现3次切换6次存储读取。元数据现合并为最多300ms一次后台序列化写入，
beforeunload/pagehide立即保存最新tab、目录和活动项。显式reload取消旧队列；
落盘前检查上次读取后的外部替换，避免退出旧窗口时覆盖较新的导入/窗口数据。
未保存正文的恢复日志继续同步，错误/重试行为保持。外观初始读取按workspace
身份缓存，全局设置订阅及跨工作区读取仍生效。

新增TC-WS-072 browser/native用例覆盖混合文件/终端、关闭移除、激活后立即
reload及末次dirty正文恢复；不增加持久化等待或写入store/storage来制造结果。
现有029/030混合恢复、034全局外观、054 release冷启动等继续保护保留行为。
本机8文件58 tests passed、TypeScript及refactor通过，最多2 workers；
不在本机执行browser/native。托管新SHA性能及生命周期验证待执行。

## HOME 本机原生根因与专项回归（2026-10-29）

用户授权本机专项性能复现，其余 browser/native 回归继续在 GitHub 执行。
使用隔离 QA release、独立 data/config/cache，在真实 HOME 下创建公开临时
文档目录；不读取用户提供的 credentials.json 正文，不修改生产配置或进程。
三次基线 notes.txt（30字符、3行）分别记录5970、4335、5042ms最长帧。
4335ms样本中七次 storage.setItem 均为0ms，不能把这次秒级停顿归因于存储。

保留的原生栈 `qa-ui-auto-report/_local/workspace-profiler-baseline/`
`combined-native-stack-02.txt` 及04/06/08显示，Tauri窗口线程从
`Webview::on_message` 同步进入 `workspace_execution_model`、
`detect_execution_model`、`ignore::Walk`，递归读取HOME里的gitignore等元数据。
同期WebProcess主线程空闲、帧回调暂停；JSC样本中的较短布局开销不能解释
整个5秒停顿。临时CSS containment试验也没有消除此停顿，未进入产品。

修复把整个执行模型发现（含root规范化）放到 `spawn_blocking`，保留命令名、
输入输出、provider、失败传播。普通文件夹中的txt/html/json/md不自动递归
发现Build/Run；源码、构建描述符和已识别项目里的文档保留自动发现，显式
Build/Run入口保持完整能力。项目识别按活动文件所属descriptor限定，跨root
不误启；切文件取消后拒绝迟到结果，Java fallback保持。

同时隔离文件树工具栏的无关渲染，文件激活同一调用栈通知平台host；普通文件
只做root级项目描述符发现，源码或显式刷新才递归。Git快照全局并发最多2、
失败释放队列，并复用目录变更计数索引。尚未实现树虚拟化及按活动文件祖先
发现HOME Git根，不把它们写成已完成。

新增TC-WS-073（browser/native）保护300文档/100目录的cold/warm/dirty路径；
074（native/release）使用真实HOME和公开文档；075（native/release）打开公开
Python源码，断言真实execution-model请求仍发生、切回文档和warm tab仍响应。
073/074额外断言零自动execution-model/递归描述符/SDK/LSP探测；075保留真实
异步模型成功或错误结果，不通过stub制造性能证据。所有路径继续执行精确
正文、高亮、EditorView复用及1500ms正文/150ms全观察期帧预算。

测量起点从dblclick前移到最早pointerdown/mousedown，保留triggerEvent、
每个原始帧及临时存储写入耗时（只记录key/长度，不保存value），结束恢复
原有方法和监听。原生观察器转发并计数execution-model请求，单测验证真实
结果/错误和callback生命周期，同时不记录HOME路径、参数及模型内容。

本机支持性验证：执行目标/编辑器/Build/Run 5文件292 tests passed；
Python probe与HOME fixture安全合同17 passed，Node原生观察器/probe合同
13 passed。TypeScript、Rust formatting、refactor gate、catalog gate通过。
073/074/075的dry-run准确选择三条，仅证明语法，尚不算实际通过。
TC-WS-030只对旧同步metadata落盘假设增加有界1秒poll；072立即reload仍无
新增等待。匹配修复源码的QA release性能实测与托管相关集结果待补。

### 本机候选的剩余长帧

首次候选实测 `run-20261029-152439-224934258` 为0 passed / 3 failed。
窗口无系统焦点，RAF稳定约1秒；075还因host_write_file正确拒绝report范围外
写入而失败。075公开源码改由HOME fixture创建，保留其严格所有权清理规则；
未放宽host_write_file权限。下载并在repo临时目录解包xdotool/Xvfb，无需sudo。
随后使用独立Xvfb显示与隔离窗口管理器，不影响生产桌面。

`run-20261029-153134-606587301` 精确执行三条，仍0 passed / 3 failed，
无skip：073普通大目录最长帧309ms，074真实HOME为229ms，075源码为247ms。
原始秒级阻塞在这些冷打开样本中未出现，但未执行到的warm/dirty路径不算通过。
不能据此宣称已达到响应预算，也不通过重跑筛掉失败。

原生JSC采样及转发DOM操作计时，把额外开销定位到首次EditorView插入后
`scrollDOM.scrollTop = 0` 强制的同步布局（89ms），另有焦点同步布局16ms。
临时size-containment对照无改善，没有进入产品。新建scroller原生位置就是0，
现跳过这次冗余写入；复用view时仍重置/恢复每个文件的横纵滚动，持久化
光标、折叠、慢读取恢复和用户输入取消恢复逻辑保留。

新增mounted测试先复现冷创建多余scroll写入，再验证同一EditorView切到新文档
归零、返回缓存文档恢复240/32位置。改前1 failed / 7 passed；修后连同真实
编辑器、慢读取恢复与缓存4文件89 passed，TypeScript通过。新release正在
编译，真实性能收益尚待测量；所有诊断注入报告只作定位证据，不作验收。

`run-20261029-155826-869721899`（去掉冷创建scroll写入后的matching release）
为1 passed / 3 failed、无skip：076真实Node项目从notes.txt自动发现并实际执行
脚本通过；073/074/075仍分别有298/277/240ms长帧。冗余scroll修复没有消除
整体冷打开布局成本，不能称作验收通过。额外诊断继续执行全部观察点并在
末尾强制保留失败判定，显示074的warm切换127–150ms，HTML冷开219ms，
JSON冷开245ms；最长帧152/197ms仍失败。上述仅用于定位，正式用例继续
在首次预算失败时失败，没有删除原始样本或放宽预算。

新增TC-WS-076以公开、无依赖Node项目保护普通文档下的真实Run入口、
自动模型成功响应与独立终端输出；同时选取原Maven Run/Build/Tests原生
用例及多语言工具配置browser用例，保留功能回归边界。076的fixture、catalog、
policy、schema和依赖同步登记。正在推进新SHA托管相关集与完整崩溃组；
冷打开长帧仍在修复中，相关集通过后继续当前分支全量验收。

## 外观样式与大目录渲染（2026-10-29 本机 QA release）

`9d70ce07` 托管64次执行为 browser 25 passed / 5 failed，native 30 passed / 4 failed，原始1473个附件摘要及源码身份已核验。全部9个失败均为150ms帧预算：browser 064/066/068/070/073，native 065/067/073/075。真实 HOME 的074及项目普通文档运行076通过，完整适用崩溃组17次执行通过；这些结果不替代后续组合源码验收。

新增真实 Host 外观生命周期回归：相同设置切换文件、第二编辑器 pane 共享样式，以及移除样式表后重新附加。改前2 failed / 1 passed；外观扩展按所有设置值做有界缓存，style-mod 4.1.3 的 ESM/CJS 路径仅在 CSS 变化时写 textContent，保留顺序、nonce、脱离 DOM 后附加的逻辑。修正后连同文档切换与性能支持测试为21 passed。此处是消除重复样式写入，不能据单测声称性能通过。

同源码的本机标准 runner `workspace-local-appearance-candidate/run-20261029-163903-131038814` 为1 passed / 3 failed：073冷打开374ms、074为267ms、075为273ms长帧；076真实脚本运行通过。连续路径诊断 `workspace-local-appearance-pipeline/run-20261029-164329-996280186` 保留失败继续收样，最后主动使case失败：073切换最大帧95–117ms，074切换79–99ms；首次打开仍有351ms/265ms长帧。观察脚本只转发原调用，不延长或删除预算；这些诊断不能作为整条case通过证据。曾隐藏树的隔离实验没有读到最终文档，探针超时，不能据其数据宣称改善，保留在 `workspace-tree-isolation-diagnostic`。

当前将 Project 树拆为逻辑行及视口渲染，超过80行时只挂载可见行和上下各8行预取；采用已有排序、压缩链、分组、错误与 dirty/Git 标记，未改变文件扫描或文件操作。键盘顺序按全部逻辑行计算，Home/End/上下及父子导航保留。077同时覆盖 browser/native 的跨屏导航不激活、真实文件、搜索/清除、列表及反向排序；073/074/075保留150/1500ms预算。虚拟行由真实滚动揭示，滚动样本另存；读取文件的计时仍从最早 pointerdown/mousedown 开始。目录树、编辑器样式、全局字体主题及完整崩溃组需要本轮匹配release与托管重新验证。


目录虚拟化后的标准本机 run `workspace-local-virtual-candidate/run-20261029-171751-679135703`
为2 passed / 5 failed：073与076通过；065/067/074/075最长帧分别为152/162/151/228ms，
仍未达到150ms预算。077首先在驱动聚焦不可聚焦的滚动容器时失败，按键入口改为已有可聚焦的
Project pane。后续真实按键已触达逻辑末行，但发现本机 WebKit 的
`Intl.Collator` 默认区域为 `en-US-u-va-posix`，即使指定 `sensitivity: "base"`，
也把大写文件名排到小写前。现在仅移除 POSIX 排序变体，保留自然语言与其他区域设置，
补充三种区域的混合大小写/数字顺序断言；原077的README/Draft10预期不放宽。

只转发DOM调用的诊断 `workspace-virtual-pipeline/run-20261029-172419-747904347`
保留全部超预算样本并在最终断言失败。073、074、075的已打开标签切换最大帧为
42–62ms；首次创建编辑器仍有154–195ms长帧。原生采样及转发栈表明首次focus包含
58–76ms同步布局。独立CSSOM插入实验没有改善（冷开仍178–234ms），未采用到产品。
这些是定位数据，不是整条用例通过，也不是正式main/candidate性能结论。

继续减少初始化的重复工作：EditorView在附加到真实host前完成插件、样式和属性构建；
空语言/签名提示不再重复reconfigure；补全初始配置记录实际安装的策略，避免随后立即再次
重建相同插件。Project虚拟行同时处理列表固定表头、容器内边距及从pane导航到行的焦点，
键盘回归改为挂载真实FileTreePane，077增加列表末行焦点及可见范围断言。
此组合正在重新编译匹配的QA release；其原生性能、077、全局字体主题和完整崩溃回归仍待验收。

## 本机冷初始化与三平台兼容性继续修正

`dc33439e` 对应 QA release source `efcd353a2d596c23c3658dc8e8db1809d7bee915abd17eb9bbc9bb344bf84600`：
本机隔离桌面标准 run `workspace-local-cold-init-candidate/run-20261029-175907-811321107`
为 1 passed / 6 failed。065/067/073/074/075 的最大帧分别为229/227/233/197/223ms；
076 的真实项目 Run/PTY 通过。077 末行已正确选中和聚焦，但 bottom=700.5px、树底界=700px，
半像素裁切失败不能放宽断言忽略。完整原始报告保留。

诊断 forwarding 和 JSC 采样确认同步焦点仍强制首次布局，耗时约76–90ms。临时诊断
仅将焦点排到编辑器测量帧，其耗时降至11–15ms，整帧仍超过150ms；该诊断主动标为失败，
不能代替无注入验收。撤回没有收益的 detached `EditorView` 构造，恢复在真实 parent 内初始化；
树打开的焦点改由一帧调度拥有，提交时重新检查请求、交互 epoch、活动 pane/file 和输入框焦点，
取消卸载和被后续请求替代的帧。保留未挂载端口的重试。初始 error stripe 已有正确 sources，
不再为相同 sources 重复排队一次空更新。

树虚拟滚动的 scroll range、sticky header 和底部留白统一使用真实容器 padding；
077 保留精确几何断言，并增加打开后真实 `.cm-content:focus` 检查。现有
`TC-IDE-TREEOPEN-01-project-tree-open-focus-native` 继续保护 Enter 后直接输入、undo、
原生磁盘 SHA、树刷新与上下文菜单焦点返回，需加入下一轮相关集。

托管 Windows/macOS 在大小写不敏感文件系统中把 `ProjectTreeRows.tsx` 与
`projectTreeRows.ts` 解析为同名模块；渲染器改名为 `projectTreeRendering.tsx`，
逻辑模型、接口与持久化契约不变。相关 hook/真实编辑器/虚拟树/stripe 支持测试
7文件33项通过，其中8项覆盖排队焦点、去重、输入框/交互/file/pane变化、迟到端口、
请求替代与卸载。匹配新产品源码的 QA release、无注入本机专项和 GitHub 三平台相关集仍待执行。

同 run 的 Linux `TC-WS-040` 已显示正确的新 root，但紧接着同步读取 localStorage
早于既有300ms元数据合并写入。用例改为最多5秒轮询同一条“恰好一个 root”表达式，
保留其UI单实例、取消、打开实际正文和目录菜单数量断言；不主动 flush 或改写存储，
也不改变文件激活的1500/150ms预算。Windows/macOS browser 的初始 App 模块失败，
原始控制台确认与上述大小写冲突同源，不能把 shard job 的 success 当作 case 通过。
