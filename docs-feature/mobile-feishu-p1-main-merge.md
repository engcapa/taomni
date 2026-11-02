# Mobile / 飞书分支合并 main 验证

日期：2026-11-02。分支：`feat/mobile-feishu-p1`。

合并远程 `origin/main` 的 `a5843405`，合并前分支为 `ef3eb4df`。
唯一文本冲突为 QA `native_pointer.py`：同时保留 main 的像素精度比较、最近几何诊断，以及当前分支持续 300ms 稳定等待和 instant 滚动。抖动回归改为持续交替亚像素宽度，在持续稳定区间内验证；原有短暂停顿、遮挡、移动和超时回归保留。

合并沿用 main 的编辑器真实文档加载后默认 import 折叠、邮件 iframe observer 生命周期和写信窗口面板边界修复。没有新产品工作流，因此沿用 TC-IDE-PARITY-011-03、TC-MAIL-CONTACTS-01 和 TC-MOBILE-001～004，加完整 crash-regression。

本地验证：

- Node 22.18.0 / pnpm 10 的完整 `pnpm build` 通过，包含 check:refactor、移动外壳和桌面前端。
- 相关前端 15 文件 88/88，保留行为另 2 文件 4/4 通过。
- QA 点击/拖拽/WebDriver、iframe 运行时错误、SSH fixture 契约 108/108 通过。
- `cargo fmt --check`、`git diff --check` 通过。
- 日志保留于 `qa-ui-auto-report/merge-main/`。

GitHub 验证：提交合并后执行三平台 browser/native，使用匹配 QA release；最终原始报告核验另行回填。
