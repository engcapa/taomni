import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import {
  probeRdpCapture,
  type RdpCaptureProbe,
  type ServerConfig,
} from "../../../lib/servers";
import { getAppPlatform } from "../../../lib/runtime";
import {
  CheckboxField,
  FieldNote,
  FormRow,
  NumberField,
  PasswordField,
  SelectField,
  TextField,
} from "../fields";
import { SystemRdpCard } from "./SystemRdpCard";

/** Per-direction clipboard tiers (design DEC-10); the backend defaults to "all". */
const CLIPBOARD_LEVELS = ["off", "text", "rich", "all"] as const;
type ClipboardLevel = (typeof CLIPBOARD_LEVELS)[number];
const DEFAULT_CLIPBOARD_FILE_MAX_MB = 2048;

function clipboardLevel(value: unknown): ClipboardLevel {
  return CLIPBOARD_LEVELS.includes(value as ClipboardLevel) ? (value as ClipboardLevel) : "all";
}

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * RDP server form: NLA credentials, security mode, and view-only toggle. The
 * server shares this machine's desktop with RDP clients (mstsc / FreeRDP).
 * Platform capability note reflects capture backend status (R0 honesty).
 */
export function RdpSettings({ config, onChange }: Props) {
  const t = useT();
  const username = typeof config.username === "string" ? config.username : "";
  const password = typeof config.password === "string" ? config.password : "";
  const domain = typeof config.domain === "string" ? config.domain : "";
  const passwordStored =
    typeof config.passwordRef === "string" && config.passwordRef.startsWith("vault:");
  const viewOnly = config.viewOnly === true;
  const allowPublicBind = config.allowPublicBind === true;
  const requireControlApproval = config.requireControlApproval !== false;
  const displayId = typeof config.displayId === "string" ? config.displayId : "";
  const clipboardToClient = clipboardLevel(config.clipboardServerToClient);
  const clipboardToServer = clipboardLevel(config.clipboardClientToServer);
  const clipboardFileMaxMb =
    typeof config.clipboardFileMaxMb === "number" && config.clipboardFileMaxMb > 0
      ? config.clipboardFileMaxMb
      : DEFAULT_CLIPBOARD_FILE_MAX_MB;
  const clipboardOptions = CLIPBOARD_LEVELS.map((level) => ({
    value: level,
    label: t(`servers.fields.rdpClipboardLevel.${level}`),
  }));
  const platform = getAppPlatform();
  const supportsDisplaySelection = platform === "macos" || platform === "windows";
  const [captureProbe, setCaptureProbe] = useState<RdpCaptureProbe | null>(null);
  const [captureProbeError, setCaptureProbeError] = useState("");
  const [requestingPermission, setRequestingPermission] = useState<
    "capture" | "control" | "refresh" | null
  >(null);
  const capabilityNote =
    platform === "macos"
      ? t("servers.notes.rdpCapMacos")
      : platform === "linux"
        ? t("servers.notes.rdpCapLinux")
        : platform === "windows"
          ? t("servers.notes.rdpCapWindows")
          : t("servers.notes.rdpCapUnknown");

  const refreshCaptureProbe = async (
    requestPermission: boolean,
    requestControlPermission = false,
  ) => {
    setRequestingPermission(
      requestPermission ? "capture" : requestControlPermission ? "control" : "refresh",
    );
    setCaptureProbeError("");
    try {
      setCaptureProbe(await probeRdpCapture(requestPermission, requestControlPermission));
    } catch (error) {
      setCaptureProbeError(String(error));
    } finally {
      setRequestingPermission(null);
    }
  };

  useEffect(() => {
    if (supportsDisplaySelection) void refreshCaptureProbe(false, false);
    // Probe when the settings panel is mounted; permission requests remain an
    // explicit user action through the button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsDisplaySelection]);

  const displayOptions = [
    { value: "", label: t("servers.fields.rdpDisplayPrimary") },
    ...(captureProbe?.displays ?? []).map((display) => ({
      value: display.id,
      label: `${display.name} — ${display.width}×${display.height}${
        display.primary ? ` (${t("servers.fields.rdpDisplayPrimaryBadge")})` : ""
      }`,
    })),
  ];

  return (
    <div className="flex flex-col">
      <SystemRdpCard config={config} onChange={onChange} />
      <FieldNote>{capabilityNote}</FieldNote>
      {supportsDisplaySelection ? (
        <SelectField
          label={t("servers.fields.rdpDisplay")}
          testId="rdp-field-display"
          value={displayId}
          onChange={(value) => onChange({ displayId: value })}
          options={displayOptions}
          width={280}
        />
      ) : null}
      {platform === "macos" ? (
        <>
          <FormRow label={t("servers.fields.rdpCapturePermission")}>
            <span style={{ color: "var(--taomni-text-muted)" }}>
              {captureProbe?.permission === "granted"
                ? t("servers.notes.rdpCaptureGranted")
                : t("servers.notes.rdpCaptureRequired")}
            </span>
            <button
              type="button"
              className="taomni-btn"
              disabled={requestingPermission !== null}
              onClick={() =>
                void refreshCaptureProbe(captureProbe?.permission !== "granted", false)
              }
            >
              {captureProbe?.permission === "granted"
                ? t("servers.fields.rdpRefreshDisplays")
                : t("servers.fields.rdpGrantCapture")}
            </button>
          </FormRow>
          {!viewOnly ? (
            <FormRow label={t("servers.fields.rdpControlPermission")}>
              <span style={{ color: "var(--taomni-text-muted)" }}>
                {captureProbe?.controlPermission === "granted"
                  ? t("servers.notes.rdpControlGranted")
                  : t("servers.notes.rdpControlRequired")}
              </span>
              <button
                type="button"
                className="taomni-btn"
                disabled={requestingPermission !== null}
                onClick={() =>
                  void refreshCaptureProbe(
                    false,
                    captureProbe?.controlPermission !== "granted",
                  )
                }
              >
                {captureProbe?.controlPermission === "granted"
                  ? t("servers.fields.rdpRefreshPermission")
                  : t("servers.fields.rdpGrantControl")}
              </button>
            </FormRow>
          ) : null}
        </>
      ) : null}
      {supportsDisplaySelection && captureProbeError ? (
        <FieldNote tone="warning">{captureProbeError}</FieldNote>
      ) : null}
      <TextField
        label={t("servers.fields.rdpUsername")}
        testId="rdp-field-username"
        value={username}
        onChange={(v) => onChange({ username: v })}
      />
      <PasswordField
        label={t("servers.fields.password")}
        testId="rdp-field-password"
        value={password}
        onChange={(v) => onChange({ password: v })}
        placeholder={passwordStored ? t("servers.fields.rdpPasswordStored") : undefined}
      />
      <TextField
        label={t("servers.fields.rdpDomain")}
        testId="rdp-field-domain"
        value={domain}
        onChange={(v) => onChange({ domain: v })}
        placeholder={t("servers.fields.optional")}
      />
      <FieldNote>{t("servers.notes.rdpHybridOnly")}</FieldNote>
      <CheckboxField
        label={t("servers.fields.viewOnly")}
        testId="rdp-field-view-only"
        checkboxLabel={t("servers.fields.viewOnly")}
        value={viewOnly}
        onChange={(v) => onChange({ viewOnly: v })}
      />
      {!viewOnly ? (
        <CheckboxField
          label={t("servers.fields.rdpControlApproval")}
          testId="rdp-field-control-approval"
          checkboxLabel={t("servers.fields.rdpControlApproval")}
          value={requireControlApproval}
          onChange={(value) => onChange({ requireControlApproval: value })}
        />
      ) : null}
      {!viewOnly && !requireControlApproval ? (
        <FieldNote tone="warning">{t("servers.notes.rdpUnattendedControl")}</FieldNote>
      ) : null}
      <SelectField
        label={t("servers.fields.rdpClipboardToClient")}
        testId="rdp-field-clipboard-to-client"
        value={clipboardToClient}
        onChange={(value) => onChange({ clipboardServerToClient: value })}
        options={clipboardOptions}
        width={220}
      />
      <SelectField
        label={t("servers.fields.rdpClipboardToServer")}
        testId="rdp-field-clipboard-to-server"
        value={clipboardToServer}
        onChange={(value) => onChange({ clipboardClientToServer: value })}
        options={clipboardOptions}
        width={220}
      />
      {clipboardToClient === "all" || clipboardToServer === "all" ? (
        <NumberField
          label={t("servers.fields.rdpClipboardFileMaxMb")}
          testId="rdp-field-clipboard-file-max-mb"
          value={clipboardFileMaxMb}
          min={1}
          max={1048576}
          onChange={(value) =>
            onChange({ clipboardFileMaxMb: Math.max(1, Math.round(value) || 1) })
          }
          width={110}
        />
      ) : null}
      <FieldNote>{t("servers.notes.rdpClipboardPolicy")}</FieldNote>
      <CheckboxField
        label={t("servers.fields.rdpPublicBind")}
        testId="rdp-field-public-bind"
        checkboxLabel={t("servers.fields.rdpPublicBind")}
        value={allowPublicBind}
        onChange={(v) => onChange({ allowPublicBind: v })}
      />
      {allowPublicBind ? (
        <FieldNote tone="warning">{t("servers.notes.rdpPublicBind")}</FieldNote>
      ) : null}
    </div>
  );
}
