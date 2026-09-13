# 可复用参考包

使用一个自包含的场景摘要，内含以下适用内容。可用 Markdown 表和 JSON 数据记录，不引入新动作 DSL；运行工件目录中保留原始文件。

| 项 | 记录 |
|---|---|
| 身份 | reference/scenario ID、IDEA version/build/edition、OS、采集时间、工具、来源 |
| 环境 | 窗口客户区/缩放、主题、UI/代码字体、locale、keymap、SDK/插件和就绪条件 |
| fixture | 相对路径、初始内容或可重建来源、文件 hash、编码/EOL、初始 dirty/选区状态 |
| 步骤 | step ID、实际 action/key/menu、前置状态、观察结果、原图链接 |
| 交互 | 焦点、选区、弹窗层级、Enter/Tab/Esc、取消/undo/返回及相关异常 |
| 视觉 | 关键区域尺寸/间距/字体/色彩角色、锚点与边缘行为、控件各状态 |
| 源码 | 仓库和 tag/commit、路径、符号/测试、解释的问题和确定性 |
| 工件 | 相对路径、hash、原图/标注/视频/原型类型、获取方式 |
| 边界 | 已观测、未观测、推断、模拟或版本不匹配；可复用的场景范围 |

视觉测量同时保留原始像素和其 DPI/客户区条件，不能跨缩放直接比较数值。允许形成设计 token 建议，但建议值不冒充 IDEA 测量结果。截取区域要链接完整原图，动态光标等噪声处理需明确掩码范围，不能遮住真实布局差异。

新任务引用同一参考 ID，而不是复制一套参照后分别维护。更换目标 build、主题或关键设置时创建修订，保留上一版来源。原始截图仅存在采集机器时给获取方式；路径/摘要存在不等于其他机器已取得原件。

已有正式双侧比较采用 `claudedocs/code-workspace-idea-specs/idea-comparison.schema.json` 与 `code-workspace-idea-task/scripts/compare_idea.py`。本参考摘要是采样和开发输入，不冒充符合该 schema 的 record。涉及目标版本变化时在新规格中确定版本支持，不能改写历史记录以得到 matched。
