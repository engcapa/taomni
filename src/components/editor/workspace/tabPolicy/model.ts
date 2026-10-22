export interface WorkspaceTabPolicyV2 {
  schemaVersion: 2;
  limitPerLeaf: number;
  order: "mru" | "alphabetical" | "open-order";
  openPosition: "end" | "after-active";
  activateOnClose: "mru" | "left" | "right";
  pinnedRow: "same" | "separate";
  previewEnabled: boolean;
  reusePreview: boolean;
}

export const DEFAULT_WORKSPACE_TAB_POLICY: WorkspaceTabPolicyV2 = {
  schemaVersion: 2,
  limitPerLeaf: 12,
  order: "open-order",
  openPosition: "end",
  activateOnClose: "mru",
  pinnedRow: "same",
  previewEnabled: true,
  reusePreview: true,
};

// ---------------------------------------------------------------------------
// §8.19.6 Tab Policy V3: per-workspace persistence with field-level repair
// ---------------------------------------------------------------------------

export interface WorkspaceTabPolicyV3 {
  schemaVersion: 3;
  limitPerLeaf: number;
  order: "mru" | "alphabetical" | "open-order";
  openPosition: "end" | "after-active";
  activateOnClose: "mru" | "left" | "right";
  pinnedRow: "same" | "separate";
  /** §8.19.6 previewMode: single-click opens a reusable preview tab. */
  previewMode: boolean;
  reusePreview: boolean;
}

export const DEFAULT_WORKSPACE_TAB_POLICY_V3: WorkspaceTabPolicyV3 = {
  schemaVersion: 3,
  limitPerLeaf: 12,
  order: "open-order",
  openPosition: "end",
  activateOnClose: "mru",
  pinnedRow: "same",
  previewMode: true,
  reusePreview: true,
};

/** Helpers accept either generation — they only read shared fields. */
export type AnyWorkspaceTabPolicy = WorkspaceTabPolicyV2 | WorkspaceTabPolicyV3;

/** Metadata the eviction decision needs for one open tab. */
export interface TabEvictionMeta {
  key: string;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  /** Larger = more recently used (e.g. Date.now() at activation). */
  lastUsedAt: number;
}

export type TabEvictionResult =
  | { kind: "within-limit"; }
  | { kind: "evicted"; evictedKeys: readonly string[]; }
  /**
   * Every candidate is protected (dirty/pinned): the leaf is allowed over
   * limit and surfaces show a reason instead of silently closing work.
   */
  | { kind: "over-limit-protected"; reason: string; };

export interface ClosedTabEntry {
  /** Stable identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  ref: unknown;
  title: string;
  subtitle: string;
  leafPath: readonly string[];
  closedAt: number;
}

export interface ClosedTabEntry {
  /** Stable identity (`root:<rootId>:<path>` / `loose:<id>:<path>`). */
  fileIdentity: string;
  ref: unknown;
  title: string;
  subtitle: string;
  leafPath: readonly string[];
  closedAt: number;
  /**
   * §8.19.6 structured relocation evidence captured at close time; entries
   * without one fall back to plain reactivation.
   */
  location?: ReopenLocationV2;
}

/**
 * §8.19.6 structured location of a closed tab, resolved against the CURRENT
 * tree at reopen time so splits closed/reshuffled afterwards still land the
 * file in the closest surviving editor.
 */
export interface ReopenLocationV2 {
  /** Leaf that owned the tab at close time (may no longer exist). */
  leafId: string | null;
  /** Child-index route from the root, recorded as first/second steps. */
  treeRoute: readonly ("first" | "second")[];
  /** Other tabs that shared the closed tab's leaf — relocation evidence. */
  siblingFileKeys: readonly string[];
}

export type ReopenResolution =
  | { kind: "restored"; leafId: string; }
  | { kind: "relocated"; leafId: string; reason: "route" | "sibling" | "active"; };

// ---------------------------------------------------------------------------
// §8.21.3 V2-B: Tab Policy Transaction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §8.21.3 V2-B / §8.26.3 AA2 / ED-TABS-002: Tab Policy Plan and Atomic Commit
// ---------------------------------------------------------------------------

export interface TabPolicyGroupImage {
  readonly id: string;
  readonly openOrder: readonly string[];
  readonly pinnedKeys: readonly string[];
  readonly previewKey: string | null;
  readonly activeKey: string | null;
}

export interface TabPolicyPlan {
  readonly workspaceInstanceId: string;
  readonly planCreatedAt: number;
  readonly baseLayoutRevision: number;
  readonly prePolicy: WorkspaceTabPolicyV3;
  readonly postPolicy: WorkspaceTabPolicyV3;
  readonly preGroups: Record<string, TabPolicyGroupImage>;
  readonly postGroups: Record<string, TabPolicyGroupImage>;
  readonly evictionsByGroup: Record<string, readonly string[]>;
  readonly allEvictedKeys: readonly string[];
  readonly dirtyEvictedKeys: readonly string[];
  readonly unreferencedEvictedKeys: readonly string[];
  readonly protectedCount: number;
  readonly isNoOp: boolean;
  readonly requiresConfirmation: boolean;
  readonly message: string;
}

export interface CreateTabPolicyPlanParams {
  workspaceInstanceId: string;
  nextPolicyRaw: unknown;
  currentPolicy?: WorkspaceTabPolicyV3;
  baseLayoutRevision?: number;
  currentGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }>;
  openFiles: Record<string, { dirty?: boolean; title?: string; }>;
  mruFileKeys: readonly string[];
  allowDirtyCandidates?: boolean;
}

export interface ApplyWorkspaceTabPolicyInput {
  rawPolicy: unknown;
  editorGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }>;
  openFiles: Record<string, { dirty?: boolean; title?: string; }>;
  mruFileKeys: readonly string[];
  allowDirtyCandidates?: boolean;
}

export interface ApplyWorkspaceTabPolicyExecution {
  policy: WorkspaceTabPolicyV3;
  evictionsByGroup: Record<string, readonly string[]>;
  allEvictedKeys: readonly string[];
  protectedCount: number;
  message: string;
}

export type TabPolicyCommitReceipt =
  | {
    readonly status: "applied";
    readonly reason?: undefined;
    readonly plan: TabPolicyPlan;
    readonly committedLayoutRevision: number;
    readonly allEvictedKeys: readonly string[];
    readonly evictedKeysByGroup: Record<string, readonly string[]>;
    readonly policy: WorkspaceTabPolicyV3;
    readonly message: string;
    readonly persisted: boolean;
    readonly persistenceIssue?: string | null;
  }
  | {
    readonly status: "no-op";
    readonly reason?: "empty";
    readonly plan: TabPolicyPlan;
    readonly allEvictedKeys: readonly string[];
    readonly evictedKeysByGroup: Record<string, readonly string[]>;
    readonly policy: WorkspaceTabPolicyV3;
    readonly message: string;
    readonly persisted?: boolean;
    readonly persistenceIssue?: string | null;
  }
  | {
    readonly status: "aborted";
    readonly reason: "user-cancelled" | "empty";
    readonly plan: TabPolicyPlan;
    readonly allEvictedKeys: readonly string[];
    readonly evictedKeysByGroup: Record<string, readonly string[]>;
    readonly policy: WorkspaceTabPolicyV3;
    readonly message: string;
    readonly persisted?: boolean;
    readonly persistenceIssue?: string | null;
  }
  | {
    readonly status: "stale";
    readonly reason: "layout-revision-changed";
    readonly plan: TabPolicyPlan;
    readonly baseLayoutRevision: number;
    readonly liveLayoutRevision: number;
    readonly allEvictedKeys: readonly string[];
    readonly evictedKeysByGroup: Record<string, readonly string[]>;
    readonly policy: WorkspaceTabPolicyV3;
    readonly message: string;
    readonly persisted?: boolean;
    readonly persistenceIssue?: string | null;
  };

/** Type alias for backwards compatibility. */
export type WorkspaceTabPolicyTransactionResult = TabPolicyCommitReceipt;

export interface ApplyWorkspaceTabPolicyTransactionParams {
  workspaceInstanceId: string;
  nextPolicyRaw: unknown;
  currentPolicy?: WorkspaceTabPolicyV3;
  baseLayoutRevision?: number;
  currentLayoutRevision?: number;
  getLiveLayoutRevision?: () => number;
  currentGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }>;
  openFiles: Record<string, { dirty?: boolean; title?: string; text?: string; }>;
  mruFileKeys: readonly string[];
  allowDirtyCandidates?: boolean;
  confirmDirtyClose?: (dirtyKeys: readonly string[]) => Promise<boolean>;
  onEvictClosedFile?: (fileKey: string) => Promise<void> | void;
  commitAtomicUpdate: (result: {
    nextGroups: Record<string, {
      openOrder: readonly string[];
      pinnedKeys: readonly string[];
      previewKey: string | null;
      activeKey: string | null;
    }>;
    evictedKeys: readonly string[];
    policy: WorkspaceTabPolicyV3;
    plan: TabPolicyPlan;
  }) => { persisted?: boolean; persistenceIssue?: string | null; } | void;
}
