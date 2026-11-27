export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export function pageNumber(value, count) {
  const number = Number(value);
  return /^\d+$/.test(value.trim()) && Number.isSafeInteger(number) && number >= 1 && number <= count
    ? number : null;
}

export function fitPageScale(width, availableWidth) {
  return Math.min(1.5, Math.max(0.2, (availableWidth - 32) / width));
}

export function canvasScale(width, height, deviceScale) {
  return Math.min(deviceScale, 8192 / Math.max(width, height), Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
}

export const MIN_PAGE_SCALE = 0.2;
export const MAX_PAGE_SCALE = 4;

export function stepPageScale(current, direction) {
  const scale = direction > 0 ? current * 1.25 : current / 1.25;
  return Number(Math.max(MIN_PAGE_SCALE, Math.min(MAX_PAGE_SCALE, scale)).toFixed(3));
}
