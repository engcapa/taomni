export type MfaRendererInput =
  | { view: "manager"; onStatusMessage: (message: string) => void }
  | { view: "floating"; onExpand: () => void };
