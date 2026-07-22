# Sockscap Linux 开发计划

**目标**：使 Linux 平台达到与 Windows 同等生产可用程度（捕获平面 + 代理 relay + 策略引擎 + 监控仪表盘 + 完整打包/发布）。

**当前状态**：仅支持规则引擎、stub relay、完整 UI 和进程列表 stub。

## Task checklist

- [x] **Phase 0：基础准备（1 周）**
  - [x] 在 `src-tauri/src/sockscap/` 中创建 `capture/linux/` 子模块。
  - [x] 实现 `SocksCapCapabilities` Linux 实现。
  - [x] 更新 `process.rs` 完善 Linux 进程列表。
  - [x] 更新 `orchestrator.rs` 添加 Linux capture 函数。
  - [x] 验证：`cargo check` + `pnpm tauri dev`。

- [ ] **Phase 1：PID 过滤与基本捕获（2-3 周）**
  - [ ] 实现进程/PID 过滤（procfs）。
  - [ ] 实现流量过滤（可选 NFQUEUE 或 raw socket）。
  - [ ] 添加 Linux 专属 relay（TUN + smoltcp）。
  - [ ] 单元测试流量、PID 匹配、relay 转发。
  - [ ] 验证：cargo test + UI smoke。

- [ ] **Phase 2：完整捕获平面与策略引擎（3-4 周）**
  - [ ] 实现网络流 NAT 与策略决策。
  - [ ] 支持 cgroup 隔离。
  - [ ] 实现流量统计与域名记录。
  - [ ] 热重载规则。
  - [ ] 验证：e2e 测试（流量穿越、决策正确性）。

- [ ] **Phase 3：打包、发布与生产准备（2 周）**
  - [ ] 更新 `tauri.conf.json` Linux 资源包含。
  - [ ] 创建 Linux 专属脚本：`stage-sockscap-linux.sh`。
  - [ ] 添加 CI 验证（Linux release build、测试、UI smoke）。
  - [ ] 文档更新。
  - [ ] 性能优化。

- [ ] **Phase 4：生产验证与发布（1 周）**
  - [ ] 运行完整测试套件（cargo test + vitest + qa-ui-auto）。
  - [ ] 发布预览版本，收集反馈。
  - [ ] 合并到主干并触发 release tag。

## Verification plan
- 在 Linux 环境运行完整测试套件（cargo test + vitest + qa-ui-auto）。
- 确认捕获能正常启动并代理流量，UI 面板显示“Active · Linux nft-tun”。
- 性能：< 5% CPU 额外开销。
- 打包：`tauri build --target x86_64-unknown-linux-gnu --bundles deb` 成功。
- 提交真实测试驱动已修改代码，并捕获 run output 作为 durable proof。

## Deviations
- [none yet]
