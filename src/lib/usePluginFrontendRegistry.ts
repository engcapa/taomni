import { useEffect } from "react";
import { usePluginFrontendStore } from "../stores/pluginFrontendStore";

export function usePluginFrontendRegistry() {
  const state = usePluginFrontendStore();
  useEffect(() => state.attach(), [state.attach]);
  return state;
}
