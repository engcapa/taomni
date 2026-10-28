# Workspace 回归：RDP 同标记迟到剪贴板发布

本项是 workspace 全量回归暴露的功能失败，不能按用户允许的 RDP/VNC 性能例外忽略。

## 改前证据

- 全量 run `40743957940` 的 macOS native `TC-RDPJ-02-joint-clipboard-no-echo` 缺少 host → client Unicode 文本公告。
- 区分性 run `40761729585`，提交 `351406518782bdd226e7ebfba98b87ddbf943aaa`，产品源码指纹 `6294904349ed0130a2eeccbee4214e1f62d8b14523ec29657248581bbcb73b3c`。
- 真 AppKit 先声明文本格式，至少 1.2 秒后发布文本。原始观测为 `declaredToken=3`、`publishedToken=3`、`heldMs=1275`、`published=true`。
- 系统文本内容与六秒无回环断言通过，但原来的 28 字符公告断言失败。该 run 最终 16 passed / 1 failed；回执、聚合及 319 个发布附件 SHA 已独立核验，基础设施无失败。
- 只读观察器另一次运行曾通过；该通过不能覆盖上述可区分的失败。

## 修复边界

`clipboard/host_poll.rs` 独立维护成功读取的标记、时间及快照是否为空。空快照沿用现有每秒内容检查频率复核，防止先消费格式声明的标记、随后永远漏掉同标记数据。稳定非空快照仍走每 250ms 廉价标记检查，避免每次 tick 读取所有格式。

保留正常文本、HTML、图片、文件、双向策略、身份去重和客户端写入不回传的语义。读取 busy 不消费标记；无系统变更标记的平台继续每秒内容比较。无 IPC、策略持久化或传输格式变更。

## 回归及验证

- 新 `TC-RDPJ-03-deferred-clipboard-publication`：macOS native 真 AppKit 同标记发布，保留原联合用例的 NLA、完整 Unicode、公告至少一次至多两次、六秒无回环、正确系统文本、正常停止及无运行时错误。fixture 无效即失败，清理恢复原剪贴板 setter；不伪造产品标记或协议公告。
- 保留 `TC-RDPJ-02-joint-clipboard-no-echo`、`TC-RDPS-NAT-02-clipboard-rich`、`TC-RDPS-NAT-03-clipboard-files`、`TC-RDPS-NAT-09-clipboard-policy`。产品变更还需完整 crash-regression browser/native。
- 本机 release Rust clipboard 单测：23 passed，包括 6 条新调度边界测试；fixture 工具单测 5 passed。未在本机运行 browser/native。
- YAML/schema、行为契约、catalog audit、`pnpm check:refactor` 通过。
- 修复定向 [40767562150](https://github.com/engcapa/taomni/actions/runs/40767562150) 已完成 21/21 passed（macOS browser 7、native 14）。原始回执和 382 个发布附件 SHA 已独立核验，包含原 02、新 03、rich/files/policy 及完整适用崩溃组。最终组合源码仍需三平台相关集及全量，不以该定向提交替代。

本机原始证据根：`/home/zhyhang/.cache/taomni-workspace-redesign-20261027/github-40761729585/`。CI 链接：<https://github.com/engcapa/taomni/actions/runs/40761729585>。
