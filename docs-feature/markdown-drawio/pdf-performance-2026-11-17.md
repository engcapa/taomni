# Markdown PDF 性能对比

测量时间：2026-11-17。优化实现已提交在 `6d7dcdf98`；本轮候选产品版本 `0c8c037e12ee6f1a322401c0523c8465e147449c`。之后原生 draw.io 导入入口的调整不改变 PDF 实现，最终回归仍会复测。

## Linux 桌面 QA release

同一台 Linux 主机、相同 release 配置、WebKitGTK、独立 X11 桌面及软件渲染。固定 FILE018 文档包含 15 节正文、表格、中文和 Mermaid，生成 12 页 A4 PDF，保持 300 DPI。每个版本连续三次，全部保留，不丢弃慢样本。用例 SHA 和执行条件 SHA 相同。

| 计时口径 | 旧版三次（秒） | 优化后三次（秒） | 中位数变化 |
| --- | --- | --- | --- |
| 自动化选完路径后等待保存完成 | 128.193 / 138.462 / 145.253 | 12.258 / 12.197 / 12.588 | 138.462 → 12.258，快 11.30 倍，耗时减少 91.15% |
| 含自动化打开/填写/确认保存框及完成等待 | 132.627 / 142.796 / 150.285 | 15.810 / 15.814 / 16.234 | 142.796 → 15.814，快 9.03 倍，耗时减少 88.93% |

这是包含轮询和自动化开销的固定操作计时，不是内部编码函数的精确时长，也不代表用户手工操作保存框所需时间。机器其他活动存在噪声；三次样本不能支持跨设备的稳定 p95 承诺。

三份实际输出逐页独立比较：每份 12 页，2480×3507 像素，所有页面 RGB 像素完全一致，全部可搜索文字一致。文件由 5,486,223 减少到 4,292,248 bytes，减少 21.76%。优化没有通过降低 DPI、改用 JPEG 或删除搜索文字取得加速。

实现减少了长文档的重复 clone、样式冻结、字体和图片嵌入，逐页复用同一份渲染模板；共享相同的冻结 HTML 样式；直接将页面 RGB 无损压缩嵌入 PDF，省去 PNG 编码、解码和再次压缩。

原始证据（工程根目录下）：

- 旧版：`qa-ui-auto-report/md-home-native-20261117/run-20261117-095914-754923723/`，QA release SHA-256 `ab0fa6b9f394b11b8b8f714b6b9d6348bdb4a4725041f5eece072e1a2e2fd825`。
- 候选：`qa-ui-auto-report/_local/markdown-drawio/native/run-20261117-113901-832345372/`，QA release SHA-256 `927d074b2d27d2af30f133dd6e34b29d18134470ff302fcc4841dc0c009cc02f`。
- 独立回执检查：`qa-ui-auto-report/_local/markdown-drawio/linux-pdf-evidence.json`。
- 时间、构建身份及逐页对比索引：`qa-ui-auto-report/_local/markdown-drawio/pdf-linux-performance-current.json`，对应 `pdf-linux-quality-current-{1,2,3}.json`。原始 PDF 保留在各次执行的 `platform-workspaces/` 中。

## 浏览器诊断与其他系统

Linux Chromium 函数诊断的旧版三次为 100.146 / 108.048 / 120.639 秒，优化原型一次 15.780 秒，约快 6.85 倍。12 页像素与搜索文字一致。该结果属于原型诊断，正式桌面比较以上表为准。

Windows/macOS 的相同 FILE018 三次原生测试已纳入 `qa-ui-auto-platforms`。当前仍等待运行结果和输出质量核对，不把 Linux/Chromium 的倍数当作 Win11 或 macOS 的实测数据。Windows hosted runner 也不等于用户的 Win11 物理机。
