import { EditorView, WidgetType } from "@codemirror/view";
import { readMarkdownImage, resolveMarkdownAsset } from "../../../lib/markdownAssets";
import { writeText } from "../../../lib/clipboard";
import { type StandaloneImage } from "./markdownModel";
import { revealSource, widgetButton, type MarkdownWidgetContext } from "./markdownWidgetContext";

const owners = new WeakMap<HTMLElement, { cancelled: boolean }>();

export class ImageWidget extends WidgetType {
  constructor(readonly from: number, readonly raw: string, readonly image: StandaloneImage, readonly context: MarkdownWidgetContext) { super(); }
  eq(other: ImageWidget): boolean { return this.from === other.from && this.raw === other.raw && this.context === other.context; }
  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void { const owner = owners.get(dom); if (owner) owner.cancelled = true; }

  toDOM(view: EditorView): HTMLElement {
    const owner = { cancelled: false };
    const root = document.createElement("figure");
    owners.set(root, owner);
    root.className = "fv-md-image";
    root.dataset.testid = "markdown-image-widget";
    root.tabIndex = 0;
    const frame = document.createElement("span");
    frame.className = "fv-md-image-frame";
    const image = document.createElement("img");
    image.alt = this.image.alt;
    if (this.image.title) image.title = this.image.title;
    frame.append(image);
    const caption = document.createElement("figcaption");
    caption.textContent = `${this.image.alt || this.context.label("图片", "Image")}（${this.image.href}）`;
    const tools = document.createElement("div");
    tools.className = "fv-md-image-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", this.context.label("图片操作", "Image actions"));
    let scale = 100;
    const zoom = widgetButton(this.context.label("缩放图片（仅视图）", "Zoom image (view only)"), () => {
      scale = scale === 100 ? 75 : scale === 75 ? 50 : 100;
      image.style.width = image.naturalWidth ? `${Math.round(image.naturalWidth * scale / 100)}px` : `${scale}%`;
      zoom.textContent = this.context.label(`缩放 ${scale}%`, `Zoom ${scale}%`);
      view.requestMeasure();
    }, this.context.label("缩放 100%", "Zoom 100%"));
    tools.append(zoom);
    if (!this.context.readOnly) tools.append(widgetButton(this.context.label("替换…", "Replace…"),
      () => this.context.replaceImage(this.from, this.from + this.raw.length)));
    tools.append(widgetButton(this.context.label("在 Explorer 中显示", "Reveal in Explorer"), () => this.context.revealImage(this.image.href)));
    tools.append(widgetButton(this.context.label("复制路径", "Copy path"), () => {
      try {
        const path = resolveMarkdownAsset(this.context.docPath, this.image.href) || this.image.href;
        void writeText(path).catch((error: unknown) => this.context.onError(String(error)));
      } catch (error) { this.context.onError(String(error)); }
    }));
    tools.append(widgetButton(this.context.label("编辑 Markdown 源码", "Edit Markdown source"), () => revealSource(view, this.from), "</>"));
    root.append(frame, tools, caption);
    root.onclick = () => { root.classList.add("is-active"); root.focus({ preventScroll: true }); };
    root.addEventListener("focusout", () => queueMicrotask(() => { if (!root.contains(document.activeElement)) root.classList.remove("is-active"); }));
    root.onkeydown = (event) => {
      if (event.key === "Escape") { root.classList.remove("is-active"); view.focus(); }
      if (event.key === "Enter" && event.target === root) { event.preventDefault(); revealSource(view, this.from); }
    };
    void readMarkdownImage(this.context.docPath, this.image.href).then((url) => {
      if (owner.cancelled) return;
      image.onload = () => { if (!owner.cancelled) view.requestMeasure(); };
      image.src = url;
    }).catch((error: unknown) => {
      if (owner.cancelled) return;
      caption.textContent = `${this.image.href} — ${error instanceof Error ? error.message : String(error)}`;
      root.classList.add("is-error");
      view.requestMeasure();
    });
    return root;
  }
}
