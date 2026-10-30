# 崩溃专项回归

每次新功能开发、UI 重构和组件升级都要运行完整 `crash-regression` 集合，再运行本次功能及受影响的既有用例。专项不代替功能回归。失败、未执行、旧源码二进制和缺失报告都不能作为通过。

`qa-ui-auto-platforms.yml` 在产品 PR 上自动选择此 tag，覆盖三平台 browser/native。手动 `selected` / `impacted` 会合并此 tag；`smoke` 包含相同集合；`all` 包含全部用例。汇总检查在所有 scope 下都要求实际用例通过。GitHub 分支保护是否要求这个 check 由仓库管理员配置，workflow 自身会在失败时返回失败。

| 用例 | 保护的状态与结果 | 模式 |
| --- | --- | --- |
| TC-WS-038 | 原始隐藏编辑器恢复崩溃路径；活动终端、草稿、Project/Documentation 及侧栏偏好保留 | browser/native |
| TC-WS-039 | 真实嵌套面板、编辑器内部分屏、隐藏／显示、resize、工具 tab 关闭及 reload；dirty 内容保留 | browser/native |
| TC-WS-045 | 空工作区从 Tools/Home 进入；折叠／展开、Sessions 导航切换；只保留一个编辑器运行时 | browser/native |
| TC-WS-051 | 工作区文件／终端混合布局及过滤；实际 PTY 输出、同一个终端、原生磁盘保存校验 | native |
| TC-WS-052 | 四个独立 dirty buffer；工具栏直接 Grid、Split/Grid/Single 连续切换；面板文件映射及跨模式返回 | browser/native |
| TC-WS-053 | 0/1/2/3 文件边界；网格关闭文件；内外两套分屏入口交替；无多余面板、dirty 保留 | browser/native |
| TC-WS-054 | QA release WebView 四真实文件布局；保存后的独立磁盘 SHA-256；冷启动及重新分屏 | native/release |
| TC-WS-055 | Sessions 空／单／四面板，关闭至空再新建；工作区混合布局及 dirty 保留；browser 本地终端不可用的错误状态也可正常操作布局 | browser |
| TC-WS-056 | 与 TC-WS-055 对应的真实 PTY：就绪后执行命令，布局后逐个检查独立输出再关闭，清空后新建执行；返回工作区原输出保留且可继续执行 | native |
| TC-WS-057 | Default Workspace 恢复 Compact 模式；Home 形状目录中浏览压缩路径与真实文件，AppData 保持折叠，导航／reload／切换视图后内容和展开状态保留；hook 回归另断言扫描范围、并发、重试及迟到响应 | browser/native |
| TC-IDE-C8-08 | 已挂载编辑器从 Actions 打开 Code Style 设置；关闭后重开仍有方案修改，dirty 正文保留且可继续输入，保护条件 Hooks 崩溃路径 | browser |

本地使用隔离的 QA 配置和测试桌面，不清理个人配置。保持 native 串行、全部本地测试 worker 总数不超过 2。下列命令应通过 `background_job.py` 启动，native 使用匹配当前源码的 QA release 二进制：

```sh
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
python -m qa_ui_auto run --mode browser --config /path/to/browser.yaml --tag crash-regression --workers 2 --require-pass
# browser 结束后，在独立 native 桌面运行：
python -m qa_ui_auto run --mode native --config /path/to/native-release.yaml --tag crash-regression --workers 1 --require-pass
```

检查所选 ID、每一步真实结果、`runtime-errors.jsonl`、原始 receipt、源码／runner／case／二进制身份。保留失败原件；更新 case 后必须重跑该 case。截图用于诊断，不能单独证明无崩溃或内容完整。

## 2026-10-27 四文件布局事故复盘

用户使用 QA release，工作区工具栏布局操作触发 `undefined is not an object (evaluating 'e[1].id')`。对应 `useWorkspaceHostCanvas` 在执行 Unsplit/Split 后继续读取原来的 Zustand 不可变快照。直接四文件 Grid 会访问不存在的 `pair[1]`；从已有 Split 进入 Grid 也可能使用被合并删除的 leaf ID，静默显示 3 个面板。

此前 TC-WS-039 验证的是编辑器内部 Split；TC-WS-018 只有两文件，TC-WS-051 只有一文件与一终端。它们都未进入四文件 Grid 分支，已有运行时错误监控没有被触发。用例通过只证明被执行的路径，不能证明该功能的所有状态安全。测试设计漏掉文件数量和前后布局状态的组合，验收时也没有核对实际进入的分支；这是本次遗漏的原因。

修复前以真实 store hook、browser 及匹配旧源码的 QA release 各自复现并保留失败；修复后从当前 store 读取每次布局操作的结果。新增用例验证面板数量、每个面板的实际选中文件、dirty 内容、恢复及磁盘结果，防止只检测异常文字却漏掉错误布局。

以后每个用户报告的崩溃必须留下可复现的专项用例，纳入此 tag。涉及新的状态、异步边界、入口或组件时，先扩充专项断言，再运行整组和受影响功能回归；不能通过 optional chaining、吞错、删除断言或缩减选择范围掩盖失败。
