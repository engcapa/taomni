// Browser preview only: no native listener is created by these settings stubs.
interface Status { enabled: boolean; address: string | null; failed_attempts: number; devices: unknown[] }
let status: Status = { enabled: false, address: null, failed_attempts: 0, devices: [] };
export async function mobileStub(command: string, args?: { port?: number; deviceId?: string }) {
  if (command === "mobile_start") status = { ...status, enabled: true, address: `http://127.0.0.1:${args?.port || 8787}` };
  if (command === "mobile_stop") status = { ...status, enabled: false, address: null };
  if (command === "mobile_pairing_code") return "preview-only-pairing-code";
  if (command === "mobile_revoke") return;
  return structuredClone(status);
}
