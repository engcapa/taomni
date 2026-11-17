"""Real Markdown source/media for printer-free PDF and sharp Word diagrams."""
import hashlib
import io
from pathlib import Path

from . import file_open_files


def setup(ctx):
    file_open_files.setup(ctx)
    root = ctx.values["file_open_root"]
    from PIL import Image, ImageDraw
    image = Image.new("RGB", (1600, 800), "white")
    draw = ImageDraw.Draw(image)
    for x in range(0, 1600, 40):
        draw.line((x, 0, x, 799), fill=(20, 80, 150), width=2)
    for y in range(0, 800, 40):
        draw.line((0, y, 1599, y), fill=(150, 40, 20), width=2)
    output = io.BytesIO(); image.save(output, format="PNG")
    vector = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect x="1" y="1" width="398" height="118" fill="#eef2ff" stroke="#2563eb"/><text x="20" y="65" font-size="24" fill="#172554">SVG image: 原始矢量文字</text></svg>'
    source = '''# Export quality 导出质量

**Readable text** with [a link](https://example.test), `inline code`, and a checked task.

Searchable Unicode: 中文检索 café é 😀.

- [x] 保留完成状态 Completed
- [ ] Pending

Math: $x^2$ and $$\\frac{1}{2}$$.

## Flowchart 方框文字

```mermaid
flowchart TD
  subgraph APP[应用启动 Application startup]
    A["加载配置<br/>Load configuration"] --> B{"权限检查<br/>Access check"}
    B -->|允许 Allow| C["保存历史<br/>Persist history"]
    B -->|拒绝 Deny| D["显示错误<br/>Show error"]
  end
  classDef readable fill:#dbeafe,stroke:#2563eb,color:#172554
  class A,B,C,D readable
```

## Sequence 时序图

```mermaid
sequenceDiagram
  participant U as 用户 User
  participant A as 应用 App
  participant D as 数据库 Database
  U->>A: 保存对话 Save conversation
  A->>D: 写入快照 Write snapshot
  D-->>A: 已完成 Completed
  A-->>U: 可恢复 Restorable
```

## Embedded images 内嵌图片

![Original raster](assets/quality.png)

![Vector label](assets/quality.svg)

## Data and code

| Item | Result |
| --- | --- |
| 中文条目 | 内容完整 |
| Export | Saved |

```typescript
const message: string = "No printer required";
console.log(message);
```
'''
    source += "\n## Pagination 分页\n\n" + "\n\n".join(f"Paragraph {i}: 保持每行文字完整，段落和图形不被页边截断。 Export retains line boundaries and the complete document." for i in range(1, 21))
    files = {"quality.md": source.encode(), "assets/quality.png": output.getvalue(), "assets/quality.svg": vector.encode()}
    if ctx.cfg["app"]["mode"] == "native":
        for name, data in files.items():
            (Path(root) / name).write_bytes(data)
        (Path(root) / "exports").mkdir(exist_ok=True)
    else:
        ctx.page.evaluate("""async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const [name, bytes] of Object.entries(files)) await vfs.vfsWriteBytes(root + '/' + name, new Uint8Array(bytes).buffer);
        }""", {"root": root, "files": {name: list(data) for name, data in files.items()}})
    ctx.values.update(markdown_quality_source=root + "/quality.md", markdown_quality_exports=root + "/exports",
                      markdown_quality_sha=hashlib.sha256(source.encode()).hexdigest())


def teardown(ctx):
    file_open_files.teardown(ctx)
