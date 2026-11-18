# draw.io renderer assets

`viewer-static.min.js` is the unmodified draw.io static viewer distribution retrieved from <https://viewer.diagrams.net/js/viewer-static.min.js>. Its SHA-256 is `c294fab9bc4bccb1790709ffa00f2d237863877f4c14d90147ef08da6d3ddd3a`. See [draw.io source](https://github.com/jgraph/drawio) and [license](LICENSE.drawio.txt).

The renderer loads on demand in a sandboxed frame. Diagram import strips remote resources and retains the original file for editable export. The [Architects Daughter license](LICENSE.architects-daughter.txt) accompanies the bundled font used by draw.io labels.

The macOS app serves the bundled renderer through the HTML preview loopback listener. The frame receives the packaged scripts and font. Diagram models travel through the frame's message channel.

The upstream distribution is minified and exempt from the source file size check. Update the viewer and recorded hash together, then verify the swimlane, connector, rich-label and editable export cases.
