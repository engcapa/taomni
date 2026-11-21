import { useEffect, useState, type CSSProperties } from "react";
import { ThemedSelect } from "../../ThemedSelect";
import { useViewerLabels } from "../viewerLabels";

export type PreviewTheme = "light" | "dark";
export type PreviewAppearance = "auto" | PreviewTheme;

function applicationTheme(): PreviewTheme {
  return document.documentElement.dataset.appTheme === "dark" ? "dark" : "light";
}

export function usePreviewTheme(appearance: PreviewAppearance): PreviewTheme {
  const [theme, setTheme] = useState(applicationTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(applicationTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-app-theme"] });
    setTheme(applicationTheme());
    return () => observer.disconnect();
  }, []);
  return appearance === "auto" ? theme : appearance;
}

/** Applied to the rendering canvas only, never the application or source pane. */
export function previewThemeStyle(theme: PreviewTheme): CSSProperties & Record<`--${string}`, string> {
  return (theme === "dark" ? {
    colorScheme: "dark", "--bg": "#191c22", "--text": "#f1f5f9", "--muted": "#cbd5e1",
    "--code-bg": "#242934", "--divider": "#64748b", "--chrome-b": "#64748b",
    "--hover": "#2c3442", "--accent-s": "#93c5fd", "--sel-b": "#93c5fd", "--sel": "#24364f",
    "--editor-sel": "rgba(92, 143, 214, 0.4)", "--editor-sel-unfocused": "rgba(92, 143, 214, 0.22)",
    "--editor-sel-match-bg": "rgba(225, 177, 75, 0.3)", "--editor-sel-match-border": "rgba(225, 177, 75, 0.72)",
    "--taomni-code-syntax-heading": "#82aaff", "--taomni-code-syntax-punctuation": "#9da5b4",
    "--taomni-code-syntax-string": "#6a9955", "--taomni-code-syntax-link": "#79b8ff",
  } : {
    colorScheme: "light", "--bg": "#ffffff", "--text": "#1f2937", "--muted": "#475569",
    "--code-bg": "#f6f8fa", "--divider": "#94a3b8", "--chrome-b": "#94a3b8",
    "--hover": "#f1f5f9", "--accent-s": "#1d4ed8", "--sel-b": "#3b82f6", "--sel": "#dbeafe",
    "--editor-sel": "rgba(37, 99, 235, 0.26)", "--editor-sel-unfocused": "rgba(37, 99, 235, 0.14)",
    "--editor-sel-match-bg": "rgba(245, 158, 11, 0.24)", "--editor-sel-match-border": "rgba(245, 158, 11, 0.58)",
    "--taomni-code-syntax-heading": "#1d4ed8", "--taomni-code-syntax-punctuation": "#64748b",
    "--taomni-code-syntax-string": "#15803d", "--taomni-code-syntax-link": "#2563eb",
  });
}

export function PreviewAppearanceControl({ value, onChange }: { value: PreviewAppearance; onChange: (value: PreviewAppearance) => void }) {
  const label = useViewerLabels();
  return <ThemedSelect className="fv-md-appearance" testId="markdown-preview-appearance" label={label("预览外观", "Preview appearance")}
    value={value} onChange={onChange} options={[
      { value: "auto", label: label("跟随应用", "Follow app") },
      { value: "light", label: label("浅色", "Light") },
      { value: "dark", label: label("深色", "Dark") },
    ]} />;
}
