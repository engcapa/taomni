import { useRef, useState } from "react";

/** The keyboard shortcut and the button share one in-flight operation. */
export function usePendingAction(action: () => Promise<void>) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}
