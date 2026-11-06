# Mobile / 飞书分支合并 main 验证

日期：2026-11-02。分支：`feat/mobile-feishu-p1`。

合并远程 `origin/main` 的 `a5843405`，合并前分支为 `257544922bd0f25ae7a02108709edfbfb7477194`。
唯一文本冲突为 QA `native_pointer.py`：同时保留 main 的像素精度比较、最近几何诊断，以及当前分支持续 300ms 稳定等待和 instant 滚动。抖动回归改为持续交替亚像素宽度，在持续稳定区间内验证；原有短暂停顿、遮挡、移动和超时回归保留。

合并沿用 main 的编辑器真实文档加载后默认 import 折叠、邮件 iframe observer 生命周期和写信窗口面板边界修复。没有新产品工作流，因此沿用 TC-IDE-PARITY-011-03、TC-MAIL-CONTACTS-01 和 TC-MOBILE-001～005，加完整 crash-regression。

本地验证：

- Node 22.18.0 / pnpm 10 的完整 `pnpm build` 通过，包含 check:refactor、移动外壳和桌面前端。
- 相关前端 15 文件 88/88，保留行为另 2 文件 4/4 通过。
- QA 点击/拖拽/WebDriver、iframe 运行时错误、SSH fixture 契约 108/108 通过。
- `cargo fmt --check`、`git diff --check` 通过。
- 日志保留于 `qa-ui-auto-report/merge-main/`。

## GitHub 验证

运行：[41388096259](https://github.com/engcapa/taomni/actions/runs/41388096259)，测试合并提交 `0db64ab0387e71b2becf4576bb4252d826f684d1`，attempt 1，`native_release=true`。TC-MOBILE-001～005、TC-MAIL-CONTACTS-01、TC-IDE-PARITY-011-03 加完整 crash-regression 共 72 次执行；selection 无 gaps/unreviewed。

| 平台 | browser | native |
| --- | --- | --- |
| Linux | 12/12 | 14/14 |
| Windows | 12/12 | 11/11 |
| macOS | 12/12 | 11/11 |

GitHub 最终 **success**。独立 `ci_collect.py` + `qa_ui_auto.ci report` 与 hosted summary 对照一致（hosted 额外 job_results 另行核对），确认 **72/72，0 failed/skipped**，`passed=true`、`report_ok=true`，failures/gaps/unreviewed/infrastructure_errors 均为空。全部 15 份原始报告实际执行、`identity_stable=true`，selection/receipt/source/runner/case/build 身份一致，均属同一 attempt 1。Mobile 独立 receipt 确认真实鉴权/CORS、双设备 PTY、桌面抢回/吊销/停止、headless 无 Display 与真实外壳/离线加载、本地及已保存会话创建的桌面 tab/PTY/磁盘结果通过。Rust 契约 83/83、该 job 前端 81/81 通过。

源码指纹 `25d41714276003921ae3a6b504917f70e73dd38a5e3e762b39e619b034f14db1`；runner 指纹 `bcd09965495bfaf371f7083e9865e5e3e32e4c557ab32869c98d05fc60cb4689`。原始报告与 receipts 位于 `qa-ui-auto-report/github/41388096259/downloads/`，契约日志为同目录父级的 `native-contracts.log`。

运行 41388026136 在规划阶段主动取消，以加入 TC-MOBILE-005；不计通过。Windows helper 26/26、原子替换 4/4 通过，日志为 `windows-build.log`。独立汇总在 `verified/ci-summary.json`，对照结论在 `verification.txt`。


三个 QA release 二进制 SHA-256 经 receipt/汇总校验一致：

| 平台 | SHA-256 |
| --- | --- |
| native-build-linux-x64-release | `fb09899813f24a753169e95054fa029a1a449d8cbe01f85c0c66acb1081fff5e` |
| native-build-windows-x64-release | `0d64faf4a09e2703ac04bea9e810b5e04028389aa52312a553c6d10602a54673` |
| native-build-macos-arm64-release | `bc6425c92d57279c334a75f9e84712f8e8dc6f782c78789178f514ac0fa319c6` |

最终证据回填仅修改本 Markdown；产品、runner、用例身份不变，测试对象为上述合并提交。真手机/真实飞书等手工验收边界延续原 review 处置文档，本次合并测试不改变其状态。
