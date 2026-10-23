import { useState } from "react";
import type { NetworkSettings } from "../../../lib/networkSettings";

export function SshExpertSettings({ value, onChange }: { value: NetworkSettings; onChange: (value: NetworkSettings) => void }) {
  const [open, setOpen] = useState(false);
  const fields = [
    ["kex", "Key exchange preference", "curve25519-sha256,diffie-hellman-group16-sha512"],
    ["cipher", "Cipher preference", "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com"],
    ["mac", "MAC preference", "hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com"],
  ] as const;
  return <div className="w-full">
    <button data-testid="session-expert-settings" className="taomni-btn" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Expert settings</button>
    {open && <div className="flex flex-col gap-2 mt-2">
      <span>Comma-separated preferences, in order. Leave blank to use the application defaults.</span>
      {fields.map(([key, label, placeholder]) => <label key={key}>{label}
        <input data-testid={`session-ssh-${key}`} className="taomni-input w-full" aria-label={label}
          placeholder={placeholder} value={value.sshExpert?.[key] ?? ""}
          onChange={(event) => onChange({ ...value, sshExpert: { ...value.sshExpert, [key]: event.target.value } })} />
      </label>)}
    </div>}
  </div>;
}
