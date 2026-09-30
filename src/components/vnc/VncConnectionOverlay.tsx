import { useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldAlert, Square } from "lucide-react";
import { useT } from "../../lib/i18n";

/**
 * Connection lifecycle overlays (VNC-SESS-003), modelled on RealVNC Viewer:
 * "Connecting to ..." with Stop, the Unencrypted connection warning shown
 * before authentication, the in-session Authentication form after a failed
 * attempt, and the reconnecting / disconnected states.
 */
export type VncOverlayView =
  | { kind: "connecting"; host: string; port: number }
  | { kind: "unencrypted"; host: string; port: number }
  | { kind: "auth"; host: string; port: number; username: string; error: string | null }
  | { kind: "reconnecting"; reason: string | null; attempt: number; secondsLeft: number }
  | { kind: "disconnected"; reason: string | null };

export interface VncOverlayActions {
  stop: () => void;
  reconnect: () => void;
  continueUnencrypted: (dontWarnAgain: boolean) => void;
  cancelUnencrypted: () => void;
  submitCredentials: (credentials: { username: string; password: string; remember: boolean }) => void;
  cancelAuth: () => void;
}

const PANEL_STYLE: React.CSSProperties = {
  background: "var(--taomni-bg-elevated, #22223a)",
  color: "var(--taomni-text, #ddd)",
  border: "1px solid var(--taomni-border, rgba(255,255,255,0.2))",
  borderRadius: 6,
  padding: 16,
  minWidth: 360,
  maxWidth: "90%",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  fontSize: 12,
};

const BUTTON_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 4,
  padding: "5px 14px",
  cursor: "pointer",
  color: "inherit",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

export function VncConnectionOverlay({ view, actions }: { view: VncOverlayView; actions: VncOverlayActions }) {
  const t = useT();
  const [dontWarn, setDontWarn] = useState(false);
  const [username, setUsername] = useState(view.kind === "auth" ? view.username : "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (view.kind === "auth") passwordRef.current?.focus({ preventScroll: true });
    else primaryRef.current?.focus({ preventScroll: true });
  }, [view.kind]);

  const backdrop = (content: React.ReactNode, testId: string) => (
    <div
      data-testid={testId}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.65)",
        zIndex: 6,
      }}
    >
      {content}
    </div>
  );

  switch (view.kind) {
    case "connecting":
      return backdrop(
        <div style={{ color: "#bbb", textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <p>{t("vnc.connectingHost", { host: view.host, port: view.port })}</p>
          <button ref={primaryRef} type="button" data-testid="vnc-connect-stop" style={BUTTON_STYLE} onClick={actions.stop}>
            <Square size={12} />
            {t("vnc.stop")}
          </button>
        </div>,
        "vnc-overlay-connecting",
      );
    case "unencrypted":
      return backdrop(
        <div role="dialog" aria-modal="true" aria-labelledby="vnc-unencrypted-title" style={PANEL_STYLE}>
          <h2 id="vnc-unencrypted-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: "flex", gap: 6, alignItems: "center" }}>
            <ShieldAlert size={16} />
            {t("vnc.unencryptedTitle")}
          </h2>
          <p style={{ marginBottom: 12, lineHeight: 1.5 }}>{t("vnc.unencryptedBody", { host: `${view.host}:${view.port}` })}</p>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 16 }}>
            <input
              type="checkbox"
              data-testid="vnc-unencrypted-dont-warn"
              checked={dontWarn}
              onChange={(event) => setDontWarn(event.target.checked)}
            />
            {t("vnc.unencryptedDontWarn")}
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              ref={primaryRef}
              type="button"
              data-testid="vnc-unencrypted-continue"
              style={BUTTON_STYLE}
              onClick={() => actions.continueUnencrypted(dontWarn)}
            >
              {t("vnc.continue")}
            </button>
            <button type="button" data-testid="vnc-unencrypted-cancel" style={BUTTON_STYLE} onClick={actions.cancelUnencrypted}>
              {t("vnc.cancel")}
            </button>
          </div>
        </div>,
        "vnc-overlay-unencrypted",
      );
    case "auth":
      return backdrop(
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="vnc-auth-title"
          style={PANEL_STYLE}
          onSubmit={(event) => {
            event.preventDefault();
            if (!password) return;
            actions.submitCredentials({ username, password, remember });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              actions.cancelAuth();
            }
          }}
        >
          <h2 id="vnc-auth-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t("vnc.authTitle")}</h2>
          <p style={{ marginBottom: 8 }}>{t("vnc.authBody", { host: `${view.host}:${view.port}` })}</p>
          {view.error && (
            <p data-testid="vnc-auth-error" role="alert" style={{ color: "#e66", marginBottom: 8 }}>{view.error}</p>
          )}
          <label style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, alignItems: "center", marginBottom: 8 }}>
            {t("vnc.authUsername")}
            <input
              data-testid="vnc-auth-username"
              className="taomni-input"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, alignItems: "center", marginBottom: 8 }}>
            {t("vnc.authPassword")}
            <input
              ref={passwordRef}
              data-testid="vnc-auth-password"
              className="taomni-input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 16 }}>
            <input
              type="checkbox"
              data-testid="vnc-auth-remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            {t("vnc.authRemember")}
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="submit" data-testid="vnc-auth-ok" style={BUTTON_STYLE} disabled={!password}>
              {t("vnc.ok")}
            </button>
            <button type="button" data-testid="vnc-auth-cancel" style={BUTTON_STYLE} onClick={actions.cancelAuth}>
              {t("vnc.cancel")}
            </button>
          </div>
        </form>,
        "vnc-overlay-auth",
      );
    case "reconnecting":
      return backdrop(
        <div style={{ color: "#ccc", textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <p style={{ color: "#e88" }}>{view.reason ? t("vnc.disconnectedReason", { reason: view.reason }) : t("vnc.disconnected")}</p>
          <p data-testid="vnc-reconnect-countdown">
            {t("vnc.reconnectingIn", { attempt: view.attempt, seconds: view.secondsLeft })}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button ref={primaryRef} type="button" data-testid="vnc-reconnect" style={BUTTON_STYLE} onClick={actions.reconnect}>
              <RefreshCw size={14} />
              {t("vnc.reconnectNow")}
            </button>
            <button type="button" data-testid="vnc-reconnect-stop" style={BUTTON_STYLE} onClick={actions.stop}>
              <Square size={12} />
              {t("vnc.stop")}
            </button>
          </div>
        </div>,
        "vnc-overlay-reconnecting",
      );
    case "disconnected":
      return backdrop(
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ color: "#e44", textAlign: "center" }}>
            <p>{view.reason ? t("vnc.disconnectedReason", { reason: view.reason }) : t("vnc.disconnected")}</p>
          </div>
          <button ref={primaryRef} type="button" data-testid="vnc-reconnect" style={BUTTON_STYLE} onClick={actions.reconnect}>
            <RefreshCw size={14} />
            {t("vnc.reconnect")}
          </button>
        </div>,
        "vnc-overlay-disconnected",
      );
  }
}
