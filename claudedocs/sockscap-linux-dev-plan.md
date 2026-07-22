# Sockscap Linux 开发计划 (with Strategist Abstraction Layer)

**目标**：Linux 捕获平面、生产级 relay、打包、CI、UI 确认，实现与 Windows 同等生产可用（PID 过滤、TUN smoltcp NAT、cgroup、流量决策、监控、发布）。

**当前状态**：rules/relay stub, PID stub, UI full, no full NAT/proxy.

## Task checklist (per strategist recommendation)
- [ ] **Phase 0：Abstraction Layer 准备（1 周）**
  - [ ] 创建 `src-tauri/src/sockscap/capture/linux/` 子目录（mod.rs, pid_filter.rs, tunnel.rs, relay.rs）。
  - [ ] 定义 `LinuxCapture` trait 和 smoltcp TUN primitives。
  - [ ] 更新 `process.rs` 和 `orchestrator.rs` 以 dispatch to abstraction (cfg(linux) only)。
  - [ ] 验证：Linux cargo check 干净。
- [ ] **Phase 1：PID / TUN / NAT 实现（2-3 周）**
  - [ ] Implement pid_filter, TUN device, smoltcp NAT in linux/。
  - [ ] Add cgroup_filter, policy decision in linux/。
  - [ ] Update orchestrator to call LinuxCapture in start_linux_stub。
  - [ ] Unit tests for each primitive.
  - [ ] 验证：cargo test + traffic proxy test。
- [ ] **Phase 2：策略、统计、UI 确认（1 周）**
  - [ ] Add domain records, stats snapshot, UI 'Active · Linux nft-tun'。
  - [ ] Hot reload in orchestrator。
  - [ ] UI smoke + proxy test。
  - [ ] 验证：real traffic + UI。
- [ ] **Phase 3：打包、发布（1 周）**
  - [ ] Linux stage script + tauri.conf updates。
  - [ ] CI integration。
  - [ ] DEB build verification。
  - [ ] 验证：`tauri build --target x86_64-unknown-linux-gnu --bundles deb` + packaging。
- [ ] **Phase 4：生产验证与发布（1 周）**
  - [ ] Full test suite + proof in scratch。
  - [ ] Release prep and tag。
  - [ ] 验证：UI 'Active' + traffic + packaging。

## Verification plan
1. gating: Plan file exists with full structure.
2. evidence: After each commit, verify Linux code compiles and tests pass.
3. gating: Run Linux packaging and assert artifacts.
4. evidence: Capture real test output (proxy, UI, <5% CPU) in {SCRATCH}.
5. skeptic: All gaps fixed (full NAT, no stub TODO, real traffic evidence).

## Deviations
- None yet (following strategist abstraction layer to unstick).

## Implementation approach (per strategist)
Create dedicated `capture/linux/` with trait and primitives to keep cfg guards minimal and commits isolated. Pure logic units testable directly. smoltcp for TUN. Changes small, commit per phase.