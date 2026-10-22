import { type WorkspaceTabPolicyV3, DEFAULT_WORKSPACE_TAB_POLICY_V3 } from "./model";

export const POLICY_ORDERS: readonly WorkspaceTabPolicyV3["order"][] = ["mru", "alphabetical", "open-order"];

export const POLICY_OPEN_POSITIONS: readonly WorkspaceTabPolicyV3["openPosition"][] = ["end", "after-active"];

export const POLICY_ACTIVATE_ON_CLOSE: readonly WorkspaceTabPolicyV3["activateOnClose"][] = ["mru", "left", "right"];

export const POLICY_PINNED_ROWS: readonly WorkspaceTabPolicyV3["pinnedRow"][] = ["same", "separate"];

/**
 * §8.19.6 migration/normalization. Accepts persisted JSON of any shape:
 * v2 objects migrate (previewEnabled→previewMode), v3 passes through, and
 * every unknown/corrupt field falls back individually to its default. The
 * raw payload is returned as `backup` whenever ANY repair happened, so the
 * caller can keep the original on disk before overwriting.
 */
export function migrateWorkspaceTabPolicy(raw: unknown): {
  policy: WorkspaceTabPolicyV3;
  repairedFields: readonly string[];
  backup: unknown;
} {
  const repairedFields: string[] = [];
  const source = (raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { policy: { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 }, repairedFields: ["*"], backup: raw ?? null };
  }

  const pickEnum = <T extends string>(field: string, allowed: readonly T[], fallback: T): T => {
    const value = source[field];
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    repairedFields.push(field);
    return fallback;
  };
  const pickNumber = (field: string, fallback: number, min: number, max: number): number => {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      const clamped = Math.min(max, Math.max(min, Math.round(value)));
      if (clamped !== value) repairedFields.push(field);
      return clamped;
    }
    repairedFields.push(field);
    return fallback;
  };
  const pickBoolean = (field: string, fallback: boolean): boolean => {
    const value = source[field];
    if (typeof value === "boolean") return value;
    repairedFields.push(field);
    return fallback;
  };

  // v2 payloads carry previewEnabled instead of previewMode.
  let previewMode = pickBoolean("previewMode", DEFAULT_WORKSPACE_TAB_POLICY_V3.previewMode);
  if (!("previewMode" in source) && typeof source.previewEnabled === "boolean") {
    previewMode = source.previewEnabled;
    repairedFields.push("previewMode(migrated-from-v2)");
  }

  const schemaVersion: WorkspaceTabPolicyV3["schemaVersion"] = source.schemaVersion === 3
    ? 3
    : (() => {
      repairedFields.push("schemaVersion");
      return 3 as const;
    })();

  const policy: WorkspaceTabPolicyV3 = {
    schemaVersion,
    limitPerLeaf: pickNumber("limitPerLeaf", DEFAULT_WORKSPACE_TAB_POLICY_V3.limitPerLeaf, 1, 100),
    order: pickEnum("order", POLICY_ORDERS, DEFAULT_WORKSPACE_TAB_POLICY_V3.order),
    openPosition: pickEnum("openPosition", POLICY_OPEN_POSITIONS, DEFAULT_WORKSPACE_TAB_POLICY_V3.openPosition),
    activateOnClose: pickEnum("activateOnClose", POLICY_ACTIVATE_ON_CLOSE, DEFAULT_WORKSPACE_TAB_POLICY_V3.activateOnClose),
    pinnedRow: pickEnum("pinnedRow", POLICY_PINNED_ROWS, DEFAULT_WORKSPACE_TAB_POLICY_V3.pinnedRow),
    previewMode,
    reusePreview: pickBoolean("reusePreview", DEFAULT_WORKSPACE_TAB_POLICY_V3.reusePreview),
  };
  return {
    policy,
    repairedFields,
    backup: repairedFields.length > 0 ? raw : null,
  };
}
