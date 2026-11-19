"""Portable multi-sheet, compressed, unsafe and text/table draw.io inputs."""
from pathlib import Path
import base64
import urllib.parse
import zlib
from . import markdown_quality


def setup(ctx):
    markdown_quality.setup(ctx)
    first = '''<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="heading" parent="1" vertex="1" taomniKind="text" taomniTag="h2" value="Imported heading 中文" style="text;html=0;"><mxGeometry x="40" y="30" width="420" height="60" as="geometry"/></mxCell>
<mxCell id="table" parent="1" vertex="1" taomniKind="table" style="group;"><mxGeometry x="40" y="110" width="420" height="80" as="geometry"/></mxCell>
<mxCell id="h" parent="table" vertex="1" taomniRow="0" taomniColumn="0" taomniHeader="1" value="Status" style="whiteSpace=wrap;fillColor=#e2e8f0;"><mxGeometry width="420" height="40" as="geometry"/></mxCell>
<mxCell id="v" parent="table" vertex="1" taomniRow="1" taomniColumn="0" value="Restored table value" style="whiteSpace=wrap;fillColor=#fff;"><mxGeometry y="40" width="420" height="40" as="geometry"/></mxCell>
<mxCell id="n1" parent="1" vertex="1" value="Start 开始" style="rounded=1;fillColor=#dbeafe;"><mxGeometry x="40" y="240" width="180" height="60" as="geometry"/></mxCell>
<mxCell id="n2" parent="1" vertex="1" value="Finish 结束" style="rhombus;fillColor=#dcfce7;"><mxGeometry x="300" y="240" width="180" height="60" as="geometry"/></mxCell>
<mxCell id="e" parent="1" edge="1" source="n1" target="n2" value="可编辑连接" style="endArrow=classic;"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>'''
    second = first.replace("Imported heading 中文", "Second sheet unique marker")
    compressor = zlib.compressobj(wbits=-15)
    compressed = base64.b64encode(compressor.compress(urllib.parse.quote(second, safe="~()*!.'-").encode()) + compressor.flush()).decode()
    xml = f'<mxfile><diagram id="one" name="Text and diagram">{first}</diagram><diagram id="two" name="Compressed second sheet">{compressed}</diagram></mxfile>'
    fixture_dir = (ctx.case_dir / "drawio-inputs").resolve()
    fixture_dir.mkdir(parents=True, exist_ok=True)
    source = fixture_dir / "multi.drawio"; source.write_text(xml, encoding="utf-8")
    invalid = fixture_dir / "invalid.drawio"; invalid.write_text("<mxfile><broken>", encoding="utf-8")
    hostile = fixture_dir / "hostile.drawio"; hostile.write_text(xml.replace("rounded=1;fillColor=#dbeafe;", "shape=image;image=data:text/plain,not-an-image;"), encoding="utf-8")
    ctx.values.update(drawio_import_file=str(source), drawio_invalid_file=str(invalid), drawio_hostile_file=str(hostile))
    graphs = '''# Editable diagram families

```mermaid
flowchart TD
  subgraph APP[Application 应用]
    A["Load 加载<br/>Configuration 配置"] --> B{Check 检查}
    B -->|Allow 允许| C[Save 保存]
  end
```

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Busy: Start 开始
  Busy --> [*]
```

```mermaid
classDiagram
  class Animal {
    +String name
    +run()
  }
  class Dog
  Animal <|-- Dog
```

```mermaid
erDiagram
  USER ||--o{ ORDER : places
  USER {
    string name
  }
```
'''
    root = ctx.values["file_open_root"]
    sequence = (Path(__file__).resolve().parents[6] / "src/components/viewer/markdown/fixtures/mermaid-agent-sequence.mmd").read_text(encoding="utf-8")
    regression = "# Mermaid export regressions\n\n```mermaid\n" + sequence + "\n```\n"
    for curve in ("linear", "stepBefore", "basis"):
        regression += f'''\n## {curve} connectors
```mermaid
---
config:
  flowchart:
    curve: {curve}
---
flowchart TD
    A[开始] --> B{{检查}}
    B -->|通过| C[保存]
    B -->|失败| D[重试]
    D --> B
```
'''
    files = {"graph-types.md": graphs, "mermaid-regressions.md": regression}
    if ctx.cfg["app"]["mode"] == "native":
        for name, text in files.items():
            (Path(root) / name).write_text(text, encoding="utf-8")
    else:
        for name, text in files.items():
            ctx.page.evaluate("""async ({path, text}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              await vfs.vfsWriteBytes(path, new TextEncoder().encode(text).buffer);
            }""", {"path": root + "/" + name, "text": text})


def teardown(ctx):
    markdown_quality.teardown(ctx)
