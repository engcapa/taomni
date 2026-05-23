import { useEffect, useMemo, useState } from "react";
import { Bot, RotateCcw, Type, Undo } from "lucide-react";
import { appThemeModeLabel, useAppTheme } from "../../lib/appTheme";
import {
  DEFAULT_TERMINAL_PROFILE,
  loadGlobalTerminalProfile,
  saveGlobalTerminalProfile,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";
import { AppThemeSwitcher } from "./AppThemeSwitcher";
import { VaultSettings } from "../vault/VaultSettings";
import { useAppStore } from "../../stores/appStore";
import { useSystemFonts } from "../../lib/systemFonts";
import { LlmProvidersPanel } from "./LlmProvidersPanel";
import { AsrPanel } from "./AsrPanel";
import { PrivacyToggle } from "./PrivacyToggle";
import { AiShellPanel } from "./AiShellPanel";
import { WebSearchPanel } from "./WebSearchPanel";
import { useAiStore } from "../../stores/aiStore";

const UI_FONTS = [
  { value: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Inter (Default UI - Highly Recommended)" },
  { value: '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Outfit (Geometric Elegant)" },
  { value: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif', label: "Segoe UI (Windows Default)" },
  { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "SF Pro / San Francisco (macOS Default)" },
  { value: '"Ubuntu", "DejaVu Sans", sans-serif', label: "Ubuntu (Linux Default)" },
  { value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif', label: "System UI Default" },
];

export function SettingsPanel() {
  const [profile, setProfile] = useState<TerminalProfile>(() => loadGlobalTerminalProfile());
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const setUiFontFamily = useAppStore((s) => s.setUiFontFamily);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const systemFonts = useSystemFonts();
  const voiceShellEnabled = useAiStore((s) => s.voiceShellEnabled);
  const toggleVoiceShell = useAiStore((s) => s.toggleVoiceShell);

  const currentSelectValue = useMemo(() => {
    if (UI_FONTS.some((f) => f.value === uiFontFamily)) {
      return uiFontFamily;
    }
    const primary = uiFontFamily.replace(/['"]/g, "").split(",")[0].trim().toLowerCase();
    const sysMatch = systemFonts.fonts.find((f) => f.toLowerCase() === primary);
    if (sysMatch) {
      return `"${sysMatch}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    }
    return uiFontFamily;
  }, [uiFontFamily, systemFonts.fonts]);

  useEffect(() => {
    saveGlobalTerminalProfile(profile);
  }, [profile]);

  return (
    <div
      data-testid="settings-panel"
      className="h-full overflow-auto"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      <div className="mx-auto max-w-5xl p-5">
        <div className="mb-4">
          <div className="text-[18px] font-semibold">Settings</div>
          <div className="text-[12px] text-[var(--moba-text-muted)]">
            Application appearance and terminal defaults
          </div>
        </div>

        <section className="mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
          <div className="mb-2 flex items-center gap-3">
            <div>
              <div className="text-[14px] font-semibold">Application Theme</div>
              <div className="text-[12px] text-[var(--moba-text-muted)]">
                Current appearance: {appThemeModeLabel(mode)} ({resolvedTheme})
              </div>
            </div>
          </div>
          <AppThemeSwitcher />
        </section>

        <section className="mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
          <div className="mb-3 flex items-center gap-3">
            <div>
              <div className="text-[14px] font-semibold flex items-center gap-2">
                <Type className="w-4 h-4 text-[var(--moba-accent)]" />
                Global UI Appearance Settings
              </div>
              <div className="text-[12px] text-[var(--moba-text-muted)]">
                Customize the typography and layout font scaling (excluding terminal / code blocks)
              </div>
            </div>
            <button
              type="button"
              className="moba-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
              onClick={() => {
                setUiFontFamily('"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
                setUiFontSize(12);
              }}
              title="Reset UI typography to defaults"
            >
              <Undo className="w-3.5 h-3.5" />
              Reset UI Font
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-2 border-t border-[var(--moba-divider)]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ui-font-family-select" className="text-[12px] font-medium text-[var(--moba-text-muted)]">
                UI Font Family
              </label>
              <select
                id="ui-font-family-select"
                className="moba-input h-8 w-full"
                value={currentSelectValue}
                onChange={(e) => setUiFontFamily(e.target.value)}
              >
                <optgroup label="Curated UI Fonts">
                  {UI_FONTS.map((font) => (
                    <option key={font.value} value={font.value}>
                      {font.label}
                    </option>
                  ))}
                </optgroup>
                {systemFonts.fonts.length > 0 && (
                  <optgroup label="All System Fonts">
                    {systemFonts.fonts.map((font) => {
                      const fontValue = `"${font}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                      return (
                        <option key={font} value={fontValue}>
                          {font}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center text-[12px] font-medium text-[var(--moba-text-muted)]">
                <label htmlFor="ui-font-size-slider">UI Base Font Size</label>
                <span className="font-mono bg-[var(--moba-selected)] text-[var(--moba-accent)] px-1.5 py-0.5 rounded text-[11px] font-semibold">
                  {uiFontSize}px
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] text-[var(--moba-text-muted)]">A</span>
                <input
                  id="ui-font-size-slider"
                  type="range"
                  min="10"
                  max="18"
                  step="1"
                  value={uiFontSize}
                  onChange={(e) => setUiFontSize(parseInt(e.target.value, 10))}
                  className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer accent-[var(--moba-accent)] bg-[var(--moba-divider)]"
                />
                <span className="text-[14px] font-semibold text-[var(--moba-text-muted)]">A</span>
              </div>
            </div>
          </div>
        </section>

        <div className="mb-4 flex items-center gap-3">
          <div>
            <div className="text-[18px] font-semibold">Terminal Appearance</div>
            <div className="text-[12px] text-[var(--moba-text-muted)]">Font and theme defaults</div>
          </div>
          <button
            data-testid="settings-reset-terminal-profile"
            className="moba-btn ml-auto h-8 inline-flex items-center gap-1.5"
            type="button"
            onClick={() => setProfile(DEFAULT_TERMINAL_PROFILE)}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
        <TerminalAppearanceSettings profile={profile} onProfileChange={setProfile} showCustomColors />

        <section className="mt-6 mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)]">
          <VaultSettings />
        </section>

        <section className="mt-6 mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
          <div className="mb-3 flex items-center gap-2">
            <Bot className="w-4 h-4 text-[var(--moba-accent)]" />
            <div>
              <div className="text-[14px] font-semibold">AI 设置</div>
              <div className="text-[11px] text-[var(--moba-text-muted)]">
                语音识别 (ASR) · LLM Provider · 隐私模式
              </div>
            </div>
          </div>

          <div className="mb-3">
            <PrivacyToggle />
          </div>

          <div className="mb-3 pt-3 border-t border-[var(--moba-divider)]">
            <AiShellPanel enabled={voiceShellEnabled} onToggle={toggleVoiceShell} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-[var(--moba-divider)]">
            <AsrPanel />
            <LlmProvidersPanel />
          </div>

          <div className="pt-3 border-t border-[var(--moba-divider)]">
            <WebSearchPanel />
          </div>
        </section>
      </div>
    </div>
  );
}
