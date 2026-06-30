import { useEffect, useState } from "react";

const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_COLOR_SCHEME_QUERY).matches;
}

export function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
    const handleChange = () => setPrefersDark(media.matches);
    handleChange();
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  return prefersDark;
}
