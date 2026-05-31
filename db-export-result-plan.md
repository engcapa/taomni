
# 修复以下query result sheet工具栏功能
- result sheet grid列，可以手工调整宽度
- 打开按钮现在实现的是保存，是要使用系统默认程序打开，如果没有弹窗提示（注意cross os linux/macos/windows都要支持）
- 添加行，修改行后没有真正的保存，应该保存并直接提交，还有删除行（正式执行前，给出一个提示，修改、添加、删除了多少记录，确认后执行或取消）

# 实现以下描述Export query result 完整功能:

  Export Grid 是一个三步向导：格式配置 → 列选择 → 输出目标

  ---
  Step 1：格式配置页

  通用部分（所有格式共享）

  Output Format（7种）：CSV / HTML / TXT / SQL / XML / Excel / JSON
  Encoding：UTF-8（可选其他编码）

  Data Format（数据格式化）

  ┌──────────────────┬──────────────────────────────────────────────────────────────┐
  │       字段       │                             说明                             │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Date             │ 日期格式，如 yyyy-MM-dd                                      │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Time             │ 时间格式，如 HH:mm:ss                                        │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Timestamp        │ 时间戳格式，如 yyyy-MM-dd HH:mm:ss                           │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Number           │ 数字格式（Unformatted 或自定义），含 Grouping/Decimal 分隔符 │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Decimal Number   │ 小数格式（同上）                                             │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Boolean          │ True/False 文本自定义（默认 true/false）                     │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Binary/BLOB      │ Don't Export / 其他选项                                      │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ CLOB             │ Don't Export / 其他选项                                      │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Null Value Text  │ 空值显示文本（默认 (null)）                                  │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Quote Text Value │ Single / Double，含 Duplicate Embedded + Quote All Values    │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ Text Function    │ None / 大小写转换等                                          │
  └──────────────────┴──────────────────────────────────────────────────────────────┘

  ---
  各格式专属 Options

  CSV
  - Column Delimiter：TAB / 逗号等
  - Row Delimiter：UNIX LF / Windows CRLF / Mac CR
  - Include Column Names ☑
  - Use any Label (Alias) ☑
  - Remove Newline Characters ☐
  - Include Original SQL：Don't Include / 可选
  - Row Comment Identifier

  HTML
  - Title / Description / Footer（支持 HTML，默认含 DbVisualizer 署名）
  - Per Table Header（HTML 模板，含 ${dbvis-timestamp} 变量）
  - Convert HTML characters ☑
  - Include Original SQL ☐
  - Use any Label (Alias) ☑

  TXT
  - Spaces Between Columns：1（列间空格数）
  - Row Delimiter：UNIX LF 等
  - Include Column Names ☑
  - Use any Label (Alias) ☑
  - Remove Newline Characters ☐
  - Include Original SQL：Don't Include

  SQL
  - Use Qualifier ☐ / Qualifier（如 test）
  - Table Name（如 employee）
  - Delimiters：None / 可选
  - Statement Separator：;
  - Include Basic DDL ☐
  - Include Original SQL：Don't Include
  - Row Comment Identifier：--
  - Add Before / Add After（在每条语句前后插入自定义文本）
  - Generate Multi-Row INSERT statements ☐
    - Rows per Multi-Row INSERT：500
    - Type：multi-insert-sql92
  - Generate MERGE statements ☐
    - Type：single-merge-sql92
    - The columns to use when matching rows：id

  XML
  - XML Style：DbVisualizer
  - Description
  - Include Original SQL ☐
  - Use any Label (Alias) ☑

  Excel (XLS/XLSX)
  - File Format：XLSX
  - Title / Description / Sheet Name
  - Include Column Names ☑
  - Use any Label (Alias) ☑
  - Export Number as Text ☐
  - Export Date/Time as Text ☑
  - Include Original SQL：None
  - Auto Resize Columns ☐

  JSON
  - JSON Style：Array
  - Use any Label (Alias) ☑

  ---
  Step 2：列选择页（Columns）

  表格列：

  ┌───────────────┬─────────────────────────────────────────────────┐
  │      列       │                      说明                       │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Export        │ 勾选控制该列是否导出                            │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Name          │ 原始列名                                        │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Label (Alias) │ 导出时使用的别名（可编辑）                      │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Type          │ 数据类型（Long / String / Date / Timestamp 等） │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Is Text       │ 是否作为文本处理                                │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Text Function │ 文本转换函数（下拉）                            │
  ├───────────────┼─────────────────────────────────────────────────┤
  │ Value         │ 值模板，默认 ${value}$                          │
  └───────────────┴─────────────────────────────────────────────────┘

  右侧操作：+ 添加列、↑↓ 调整顺序、全选/全不选

  ---
  Step 3：输出目标页（Output Destination）

  三种输出方式：
  - File：指定文件路径（含历史下拉 + 文件夹浏览按钮）
  - SQL Commander：输出到编辑器（New Editor / 已有编辑器），插入位置：At Caret / First / Last / Replace All
  - Clipboard：直接复制到剪贴板

  Settings 菜单（左下角）：
  - Save As Default Settings — 保存当前配置为默认
  - Use Default Settings — 恢复默认配置
  - Remove Default Settings — 删除默认配置
  - Load... — 从文件加载配置
  - Save As... — 保存配置到文件
  - Copy Settings to Clipboard — 复制配置到剪贴板

  最终操作按钮：< Back / Export / Cancel