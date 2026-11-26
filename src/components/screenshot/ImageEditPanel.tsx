import { useState } from "react";
import { useT } from "../../lib/i18n";
import { MAX_RESIZE, NEUTRAL_ADJUST, type ImageEdit } from "../../lib/screenshotImage";
import { Modal } from "../ui/Modal";

export function ImageEditPanel({ width, height, busy, canUndo, canRedo, returnFocus, onApply, onUndo, onRedo, onExternal, onClose }: {
  width: number; height: number; busy: boolean; canUndo: boolean; canRedo: boolean;
  returnFocus?: HTMLElement | null;
  onApply: (edit: ImageEdit) => void; onUndo: () => void; onRedo: () => void;
  onExternal: (choose: boolean) => void; onClose: () => void;
}) {
  const t = useT();
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [lock, setLock] = useState(true);
  const [crop, setCrop] = useState({ x: 0, y: 0, width, height });
  const [adjust, setAdjust] = useState(NEUTRAL_ADJUST);
  const button = "taomni-btn";
  const valid = Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1 && w <= MAX_RESIZE && h <= MAX_RESIZE && w * h <= 64_000_000;
  const validCrop = Object.values(crop).every(Number.isFinite) && crop.x >= 0 && crop.y >= 0 && crop.width >= 1 && crop.height >= 1 && crop.x + crop.width <= width && crop.y + crop.height <= height;
  return <Modal title={t("screenshot.editImage")} testId="screenshot-edit-panel" size="wide"
    initialFocus='[data-testid="screenshot-edit-width"]' returnFocus={returnFocus} onCancel={onClose}
    footer={<button type="button" className={button} data-testid="screenshot-edit-close" onClick={onClose}>{t("common.close")}</button>}>
      <p className="mb-3 text-[var(--taomni-text-muted)]">{width} × {height} · {t("screenshot.editHint")}</p>
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} data-testid="screenshot-edit-rotate" onClick={() => onApply({ kind: "rotate", quarterTurns: 1 })}>{t("screenshot.rotateRight")}</button>
          <button type="button" className={button} data-testid="screenshot-edit-flip-horizontal" onClick={() => onApply({ kind: "flip", axis: "horizontal" })}>{t("screenshot.flipHorizontal")}</button>
          <button type="button" className={button} data-testid="screenshot-edit-flip-vertical" onClick={() => onApply({ kind: "flip", axis: "vertical" })}>{t("screenshot.flipVertical")}</button>
        </div>
        <div className="flex flex-wrap gap-2 items-center text-ui-body">
          <label>{t("screenshot.imageWidth")} <input data-testid="screenshot-edit-width" type="number" min={1} max={MAX_RESIZE} value={w} className="taomni-input w-20 px-2" onChange={(e) => { setW(e.target.valueAsNumber); if (lock) setH(Math.round(e.target.valueAsNumber * height / width)); }} /></label>
          <label>{t("screenshot.imageHeight")} <input data-testid="screenshot-edit-height" type="number" min={1} max={MAX_RESIZE} value={h} className="taomni-input w-20 px-2" onChange={(e) => { setH(e.target.valueAsNumber); if (lock) setW(Math.round(e.target.valueAsNumber * width / height)); }} /></label>
          <label><input data-testid="screenshot-edit-lock" type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> {t("screenshot.lockRatio")}</label>
          <button type="button" data-testid="screenshot-edit-resize" className={button} disabled={!valid} onClick={() => onApply({ kind: "resize", width: w, height: h })}>{t("screenshot.resizeImage")}</button>
        </div>
        <div className="flex flex-wrap gap-2 items-center text-ui-body">
          {(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{key}
            <input data-testid={`screenshot-edit-crop-${key}`} type="number" min={key === "x" || key === "y" ? 0 : 1} value={crop[key]} className="taomni-input w-16 px-1 ml-1"
              onChange={(e) => setCrop({ ...crop, [key]: e.target.valueAsNumber })} /></label>)}
          <button type="button" data-testid="screenshot-edit-crop" className={button} disabled={!validCrop} onClick={() => onApply({ kind: "crop", ...crop })}>{t("screenshot.recrop")}</button>
        </div>
        {(["brightness", "contrast", "saturation"] as const).map((key) => <label key={key} className="flex items-center gap-2 text-ui-body">
          <span className="w-20">{t(`screenshot.${key}`)}</span><input data-testid={`screenshot-edit-${key}`} type="range" min={0} max={200} value={adjust[key]} className="flex-1 min-w-0" onChange={(e) => setAdjust({ ...adjust, [key]: Number(e.target.value) })} /><span className="w-10">{adjust[key]}%</span>
        </label>)}
        <div className="flex gap-3 items-center text-ui-body">
          {(["grayscale", "invert"] as const).map((key) => <label key={key}><input data-testid={`screenshot-edit-${key}`} type="checkbox" checked={adjust[key]} onChange={(e) => setAdjust({ ...adjust, [key]: e.target.checked })} /> {t(`screenshot.${key}`)}</label>)}
          <button type="button" data-testid="screenshot-edit-adjust" className={button} onClick={() => onApply({ kind: "adjust", ...adjust })}>{t("screenshot.watermarkApply")}</button>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-[var(--taomni-divider)] pt-3">
          <button type="button" data-testid="screenshot-edit-undo" className={button} disabled={!canUndo} onClick={onUndo}>{t("screenshot.undo")}</button>
          <button type="button" data-testid="screenshot-edit-redo" className={button} disabled={!canRedo} onClick={onRedo}>{t("screenshot.redo")}</button>
          <button type="button" data-testid="screenshot-edit-external" className={button} onClick={() => onExternal(false)}>{t("screenshot.externalEditor")}</button>
          <button type="button" data-testid="screenshot-edit-choose" className={button} onClick={() => onExternal(true)}>{t("screenshot.chooseEditor")}</button>
        </div>
      </fieldset>
  </Modal>;
}
