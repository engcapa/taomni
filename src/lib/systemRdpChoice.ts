import { choiceAppDialog, confirmAppDialog } from "./appDialogs";
import { t } from "./i18n";
import {
  openSystemRdpSettings,
  probeSystemRdp,
  systemRdpAlternativePort,
  type ServerConfig,
  type SystemRdpStatus,
} from "./servers";

export interface RdpStartDecision {
  /** False when the user chose the system Remote Desktop or cancelled. */
  proceed: boolean;
  /** Config changes to persist before starting (choice, conflict-free port). */
  patch?: Partial<ServerConfig>;
  /** Human-readable log lines explaining the decision. */
  notes: string[];
}

function portPatch(status: SystemRdpStatus, config: ServerConfig, notes: string[]): Partial<ServerConfig> {
  const alternative = systemRdpAlternativePort(status, config.port);
  if (alternative === null) return {};
  notes.push(
    t("servers.systemRdp.portMoved", { from: config.port || 3389, to: alternative }),
  );
  return { port: alternative };
}

/**
 * Windows branch of starting Taomni's RDP server (design §4.1 / DEC-05).
 *
 * When the operating system can already host Remote Desktop, recommend it and
 * start Taomni only after an explicit confirmation, which is remembered as
 * `systemRdpChoice: "taomni"`. Probe failures never block the start.
 */
export async function decideRdpStart(config: ServerConfig): Promise<RdpStartDecision> {
  const notes: string[] = [];
  let status: SystemRdpStatus | null = null;
  try {
    status = await probeSystemRdp();
  } catch (error) {
    notes.push(t("servers.systemRdp.probeFailed", { error: String(error) }));
    return { proceed: true, notes };
  }
  if (!status?.applicable) return { proceed: true, notes };

  const chosen = config.systemRdpChoice === "taomni";
  const recommendation = status.recommendation ?? "unknown";
  if (chosen || recommendation === "taomni" || recommendation === "unknown") {
    if (recommendation === "unknown" && status.errors?.length) {
      notes.push(t("servers.systemRdp.probeFailed", { error: status.errors.join("; ") }));
    }
    return { proceed: true, patch: portPatch(status, config, notes), notes };
  }

  const port = status.port ?? 3389;
  if (recommendation === "use-system") {
    const answer = await choiceAppDialog({
      title: t("servers.systemRdp.dialogTitle"),
      message: t("servers.systemRdp.useSystemMessage", { port }),
      primaryLabel: t("servers.systemRdp.useSystemAction"),
      secondaryLabel: t("servers.systemRdp.useTaomniAction"),
      cancelLabel: t("servers.cancel"),
    });
    if (answer !== "secondary") {
      notes.push(t("servers.systemRdp.keptSystem"));
      return { proceed: false, notes };
    }
  } else if (recommendation === "enable-system") {
    const answer = await choiceAppDialog({
      title: t("servers.systemRdp.dialogTitle"),
      message: t("servers.systemRdp.enableSystemMessage"),
      primaryLabel: t("servers.systemRdp.openSettingsAction"),
      secondaryLabel: t("servers.systemRdp.useTaomniAction"),
      cancelLabel: t("servers.cancel"),
    });
    if (answer === "primary") {
      try {
        await openSystemRdpSettings();
        notes.push(t("servers.systemRdp.settingsOpened"));
      } catch (error) {
        notes.push(String(error));
      }
      return { proceed: false, notes };
    }
    if (answer !== "secondary") {
      notes.push(t("servers.systemRdp.cancelled"));
      return { proceed: false, notes };
    }
  } else {
    const confirmed = await confirmAppDialog({
      title: t("servers.systemRdp.dialogTitle"),
      message: t("servers.systemRdp.needsAdminMessage"),
      confirmLabel: t("servers.systemRdp.useTaomniAction"),
      cancelLabel: t("servers.cancel"),
    });
    if (!confirmed) {
      notes.push(t("servers.systemRdp.cancelled"));
      return { proceed: false, notes };
    }
  }
  notes.push(t("servers.systemRdp.choseTaomni"));
  return {
    proceed: true,
    patch: { systemRdpChoice: "taomni", ...portPatch(status, config, notes) },
    notes,
  };
}
