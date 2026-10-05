/** One failing load, including React StrictMode's same-turn effect replay. */
export function createScreenshotFavoritesFault() {
  let consumed = false;
  return (mode: string | null): boolean => {
    if (mode === "always") return true;
    if (mode !== "once" || consumed) return false;
    setTimeout(() => { consumed = true; }, 0);
    return true;
  };
}
