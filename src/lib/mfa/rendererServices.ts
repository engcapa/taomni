import { useAppStore } from "../../stores/appStore";

export function useFloatingMfa() {
  const floating = useAppStore((state) => state.floatingMfa);
  const setPosition = useAppStore((state) => state.setFloatingMfaPosition);
  const setPinned = useAppStore((state) => state.setFloatingMfaPinned);
  const setSearch = useAppStore((state) => state.setFloatingMfaSearch);
  const close = useAppStore((state) => state.closeFloatingMfa);
  const setStatusMessage = useAppStore((state) => state.setStatusMessage);
  return { floating, setPosition, setPinned, setSearch, close, setStatusMessage };
}

export function isFloatingMfaOpen() {
  return useAppStore.getState().floatingMfa.open;
}
