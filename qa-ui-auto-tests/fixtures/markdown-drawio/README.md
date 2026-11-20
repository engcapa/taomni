`roundtrip.drawio.png` comes from draw.io Desktop 29.6.6 on Linux. TC-FILE-OPEN-031 and TC-FILE-OPEN-032 compare the rendered Markdown against it. The source contains three editable shapes, labeled solid arrows and a dashed return with a waypoint.

Regenerate the reference from this directory with the draw.io Desktop CLI.

```sh
drawio --export --format png --border 12 --output roundtrip.drawio.png roundtrip.drawio
```
