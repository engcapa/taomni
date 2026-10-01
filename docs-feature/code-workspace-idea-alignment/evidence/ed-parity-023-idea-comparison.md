# ED-PARITY-023 性能对照记录

- 对照对象不是 IDEA 视觉，而是同一平台上 Taomni 修复前后的输入响应；IDEA 在本机 Linux 上输入流畅，是用户给出的期望基线。
- 测量环境：本机 i7-6700K / Intel HD 530，WebKitGTK 2.52.6（MiniBrowser + WebKitWebDriver，browser-preview 生产包），Chrome CDP 4× CPU 降速 Profile；测量脚本 `/tmp/perfk`（未入库）。

| 指标 | 修复前 | 修复后 | 结论 |
|---|---|---|---|
| WebKitGTK 光标移动 p50（key→paint） | 69 ms | 26 ms | improved |
| WebKitGTK 连续操作长帧合计 | 15.2 s | 0.1 s | improved |
| Chrome 4× 降速输入 p95 | 84 ms | 47 ms | improved |
| 每次光标移动的 CodeWorkspaceTab 重渲染 | 2 次整页 + 15 个底部面板 | 仅变化部分 | fixed |
| native 回归 | — | TC-IDE-LAT-01（真实 JDT LS 连续输入）三端通过 | passed |

未验证：打包后 native 的逐键 key→paint 分布只由 TC-IDE-LAT-01 的 p95 门槛覆盖，没有与修复前同条件的 native 对照样本。
