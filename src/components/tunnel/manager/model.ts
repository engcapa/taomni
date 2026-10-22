export interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}

export type TunnelLogLevel = "info" | "success" | "error";

export interface TunnelLogEntry {
  id: string;
  level: TunnelLogLevel;
  text: string;
  /** Wall-clock ms; rendered as HH:MM:SS in the panel. */
  ts: number;
}
