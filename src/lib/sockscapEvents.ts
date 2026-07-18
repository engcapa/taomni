/** Stable event names shared by desktop IPC and the browser-only Tauri stub. */
export const SOCKSCAP_EVENTS = {
  status: "sockscap://status",
  trafficSummary: "sockscap://traffic-summary",
  profileHealth: "sockscap://profile-health",
  egressHealth: "sockscap://egress-health",
  alert: "sockscap://alert",
  navigate: "sockscap://navigate",
} as const;
