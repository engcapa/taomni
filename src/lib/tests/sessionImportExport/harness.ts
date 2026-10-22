import type { SessionConfig } from "../../ipc";

export function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "session-1",
    name: "Prod",
    session_type: "SSH",
    group_path: "User sessions / Production",
    host: "prod.example.com",
    port: 22,
    username: "deploy",
    auth_method: { PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } },
    options_json: JSON.stringify({
      x11: false,
      compression: true,
      startupCmd: "uptime",
      jumpHost: "bastion.example.com",
      jumpUser: "jump",
      jumpPort: "2222",
      terminalProfile: {
        fontFamily: "JetBrains Mono",
        fontSize: 13,
        fontLigatures: true,
        theme: "classic",
        scrollback: 5000,
        cursorStyle: "block",
        cursorBlink: true,
        showScrollbar: true,
        copyOnSelect: false,
        rightClickBehavior: "menu",
        readOnly: false,
        bracketedPaste: true,
        multilinePasteConfirm: true,
        syntaxMode: "shell",
        loggingEnabled: false,
        logPath: "C:\\secret\\terminal.log",
      },
      disableAiWrite: true,
    }),
    created_at: 100,
    updated_at: 100,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

export function encodeUtf16LeWithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0xff);
  view.setUint8(1, 0xfe);
  for (let i = 0; i < text.length; i += 1) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  return out;
}

export function makeStoredZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, centralParts.length, true);
  eocdView.setUint16(10, centralParts.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);

  const all = [...localParts, ...centralParts, eocd];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
