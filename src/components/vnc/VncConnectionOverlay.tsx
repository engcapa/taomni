import { useEffect, useRef, useState } from "react";
import { LockKeyhole, RefreshCw, ShieldAlert, Square } from "lucide-react";
import { useT } from "../../lib/i18n";
import "./VncConnectionOverlay.css";

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
      className="vnc-connection-backdrop"
    >
      {content}
    </div>
  );

  switch (view.kind) {
    case "connecting":
      return backdrop(
        <div className="vnc-connection-card vnc-connection-status" role="status">
          <p>{t("vnc.connectingHost", { host: view.host, port: view.port })}</p>
          <button ref={primaryRef} type="button" data-testid="vnc-connect-stop" className="vnc-connection-button" onClick={actions.stop}>
            <Square size={12} />
            {t("vnc.stop")}
          </button>
        </div>,
        "vnc-overlay-connecting",
      );
    case "unencrypted":
      return backdrop(
        <div role="dialog" aria-modal="true" aria-labelledby="vnc-unencrypted-title" aria-describedby="vnc-unencrypted-body" className="vnc-connection-card">
          <h2 id="vnc-unencrypted-title" className="vnc-connection-title">
            <span className="vnc-connection-icon"><ShieldAlert size={20} /></span>
            {t("vnc.unencryptedTitle")}
          </h2>
          <p id="vnc-unencrypted-body" className="vnc-connection-description">{t("vnc.unencryptedBody", { host: `${view.host}:${view.port}` })}</p>
          <label className="vnc-connection-check">
            <input
              type="checkbox"
              data-testid="vnc-unencrypted-dont-warn"
              checked={dontWarn}
              onChange={(event) => setDontWarn(event.target.checked)}
            />
            {t("vnc.unencryptedDontWarn")}
          </label>
          <div className="vnc-connection-actions">
            <button type="button" data-testid="vnc-unencrypted-cancel" className="vnc-connection-button" onClick={actions.cancelUnencrypted}>
              {t("vnc.cancel")}
            </button>
            <button
              ref={primaryRef}
              type="button"
              data-testid="vnc-unencrypted-continue"
              className="vnc-connection-button vnc-connection-primary"
              onClick={() => actions.continueUnencrypted(dontWarn)}
            >
              {t("vnc.continue")}
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
          aria-describedby="vnc-auth-body"
          className="vnc-connection-card"
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
          <h2 id="vnc-auth-title" className="vnc-connection-title">
            <span className="vnc-connection-icon"><LockKeyhole size={20} /></span>
            {t("vnc.authTitle")}
          </h2>
          <p id="vnc-auth-body" className="vnc-connection-description">{t("vnc.authBody", { host: `${view.host}:${view.port}` })}</p>
          {view.error && (
            <p data-testid="vnc-auth-error" role="alert" className="vnc-connection-error">{view.error}</p>
          )}
          <label className="vnc-connection-field">
            {t("vnc.authUsername")}
            <input
              data-testid="vnc-auth-username"
              className="taomni-input vnc-connection-input"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="vnc-connection-field">
            {t("vnc.authPassword")}
            <input
              ref={passwordRef}
              data-testid="vnc-auth-password"
              className="taomni-input vnc-connection-input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="vnc-connection-check">
            <input
              type="checkbox"
              data-testid="vnc-auth-remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            {t("vnc.authRemember")}
          </label>
          <div className="vnc-connection-actions">
            <button type="button" data-testid="vnc-auth-cancel" className="vnc-connection-button" onClick={actions.cancelAuth}>
              {t("vnc.cancel")}
            </button>
            <button type="submit" data-testid="vnc-auth-ok" className="vnc-connection-button vnc-connection-primary" disabled={!password}>
              {t("vnc.ok")}
            </button>
          </div>
        </form>,
        "vnc-overlay-auth",
      );
    case "reconnecting":
      return backdrop(
        <div className="vnc-connection-card vnc-connection-status">
          <p className="vnc-connection-error">{view.reason ? t("vnc.disconnectedReason", { reason: view.reason }) : t("vnc.disconnected")}</p>
          <p data-testid="vnc-reconnect-countdown">
            {t("vnc.reconnectingIn", { attempt: view.attempt, seconds: view.secondsLeft })}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button ref={primaryRef} type="button" data-testid="vnc-reconnect" className="vnc-connection-button vnc-connection-primary" onClick={actions.reconnect}>
              <RefreshCw size={14} />
              {t("vnc.reconnectNow")}
            </button>
            <button type="button" data-testid="vnc-reconnect-stop" className="vnc-connection-button" onClick={actions.stop}>
              <Square size={12} />
              {t("vnc.stop")}
            </button>
          </div>
        </div>,
        "vnc-overlay-reconnecting",
      );
    case "disconnected":
      return backdrop(
        <div className="vnc-connection-card vnc-connection-status">
          <div className="vnc-connection-error">
            <p>{view.reason ? t("vnc.disconnectedReason", { reason: view.reason }) : t("vnc.disconnected")}</p>
          </div>
          <button ref={primaryRef} type="button" data-testid="vnc-reconnect" className="vnc-connection-button vnc-connection-primary" onClick={actions.reconnect}>
            <RefreshCw size={14} />
            {t("vnc.reconnect")}
          </button>
        </div>,
        "vnc-overlay-disconnected",
      );
  }
}
