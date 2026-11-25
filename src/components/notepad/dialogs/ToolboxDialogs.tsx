import { useEffect, useState } from "react";
import { Copy, X } from "lucide-react";
import { notepadHash } from "../../../lib/notepad/ipc";
import { writeText } from "../../../lib/clipboard";
import { runMimeTransform } from "../../../lib/notepad/transforms/mime";
import { useViewerLabels } from "../../viewer/viewerLabels";

export type NotepadToolboxKind = "hash" | "mime" | null;

export function ToolboxDialogs({
  kind,
  documentText,
  selectionText,
  filePath,
  onClose,
  onApplyText,
}: {
  kind: NotepadToolboxKind;
  documentText: string;
  selectionText: string;
  filePath: string | null;
  onClose: () => void;
  onApplyText: (nextText: string, onlySelection: boolean) => void;
}) {
  const label = useViewerLabels();
  const [algo, setAlgo] = useState<"md5" | "sha1" | "sha256" | "sha512">("sha256");
  const [hashSource, setHashSource] = useState<"doc" | "sel" | "file">("doc");
  const [hashHex, setHashHex] = useState("");
  const [hashErr, setHashErr] = useState<string | null>(null);

  const [workText, setWorkText] = useState(selectionText || documentText);
  const [mimeErr, setMimeErr] = useState<string | null>(null);

  useEffect(() => {
    if (kind === "mime") {
      setWorkText(selectionText || documentText);
      setMimeErr(null);
    } else if (kind === "hash") {
      setHashHex("");
      setHashErr(null);
      setHashSource((prev) => {
        if (prev === "sel" && !selectionText) return "doc";
        if (prev === "file" && !filePath) return "doc";
        return prev;
      });
    }
  }, [kind, selectionText, documentText, filePath]);

  if (!kind) return null;

  if (kind === "hash") {
    const compute = async () => {
      setHashErr(null);
      try {
        const res =
          hashSource === "file" && filePath
            ? await notepadHash({ algorithm: algo, filePath })
            : await notepadHash({
                algorithm: algo,
                text: hashSource === "sel" ? selectionText : documentText,
              });
        setHashHex(res.hex);
      } catch (e) {
        setHashErr(e instanceof Error ? e.message : String(e));
      }
    };

    return (
      <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-hash-dialog">
        <div className="np-modal">
          <div className="np-modal-header">
            <span>{label("MD5 / SHA 摘要生成器", "MD5 / SHA Hash Generator")}</span>
            <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
          </div>

          <div className="flex flex-wrap gap-2 text-ui-body">
            {(["md5", "sha1", "sha256", "sha512"] as const).map((a) => (
              <button
                key={a}
                type="button"
                data-testid={`notepad-hash-algo-${a}`}
                className={`np-btn ${algo === a ? "primary" : ""}`}
                onClick={() => setAlgo(a)}
              >
                {a.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="flex gap-4 text-ui-body">
            <label className="inline-flex items-center gap-1">
              <input type="radio" checked={hashSource === "doc"} onChange={() => setHashSource("doc")} />
              {label("当前全文", "Document")}
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="radio" disabled={!selectionText} checked={hashSource === "sel"} onChange={() => setHashSource("sel")} />
              {label("选中内容", "Selection")}
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="radio" disabled={!filePath} checked={hashSource === "file"} onChange={() => setHashSource("file")} />
              {label("磁盘文件", "Disk File")}
            </label>
          </div>

          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-hash-generate"
            onClick={() => void compute()}
          >
            {label("计算哈希值", "Generate Hash")}
          </button>

          {hashHex && (
            <div className="flex gap-2 items-center">
              <input
                type="text"
                readOnly
                className="np-input flex-1 font-mono"
                data-testid="notepad-hash-output"
                value={hashHex}
              />
              <button
                type="button"
                className="np-btn"
                onClick={() => void writeText(hashHex)}
                title={label("复制", "Copy")}
              >
                <Copy size={13} />
              </button>
            </div>
          )}
          {hashErr && <div className="text-ui-body text-red-500">{hashErr}</div>}
        </div>
      </div>
    );
  }

  const runTransform = (fn: (s: string) => string) => {
    setMimeErr(null);
    try {
      setWorkText(fn(workText));
    } catch (e) {
      setMimeErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-mime-dialog">
      <div className="np-modal wide">
        <div className="np-modal-header">
          <span>{label("编码解码与 JSON 工具箱", "MIME / JSON / Hex Toolbox")}</span>
          <button type="button" className="np-btn" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="np-btn" data-testid="notepad-mime-b64-enc" onClick={() => runTransform((s) => runMimeTransform("b64e", s))}>Base64 Encode</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-b64-dec" onClick={() => runTransform((s) => runMimeTransform("b64d", s))}>Base64 Decode</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-url-enc" onClick={() => runTransform((s) => runMimeTransform("urle", s))}>URL Encode</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-url-dec" onClick={() => runTransform((s) => runMimeTransform("urld", s))}>URL Decode</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-hex-enc" onClick={() => runTransform((s) => runMimeTransform("a2h", s))}>ASCII → Hex</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-hex-dec" onClick={() => runTransform((s) => runMimeTransform("h2a", s))}>Hex → ASCII</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-json-pretty" onClick={() => runTransform((s) => JSON.stringify(JSON.parse(s), null, 2))}>JSON Format</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-json-mini" onClick={() => runTransform((s) => JSON.stringify(JSON.parse(s)))}>JSON Minify</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-json-esc" onClick={() => runTransform((s) => JSON.stringify(s))}>JSON Escape</button>
          <button type="button" className="np-btn" data-testid="notepad-mime-json-unesc" onClick={() => runTransform((s) => String(JSON.parse(s)))}>JSON Unescape</button>
        </div>

        <textarea
          rows={8}
          className="np-input font-mono h-auto py-2"
          data-testid="notepad-mime-textarea"
          value={workText}
          onChange={(e) => setWorkText(e.target.value)}
        />
        {mimeErr && <div className="text-ui-body text-red-500">{mimeErr}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="np-btn" onClick={onClose}>{label("关闭", "Close")}</button>
          <button
            type="button"
            className="np-btn primary"
            data-testid="notepad-mime-apply"
            onClick={() => {
              onApplyText(workText, Boolean(selectionText));
              onClose();
            }}
          >
            {selectionText ? label("写回选中内容", "Apply to Selection") : label("写回当前文档", "Apply to Document")}
          </button>
        </div>
      </div>
    </div>
  );
}
