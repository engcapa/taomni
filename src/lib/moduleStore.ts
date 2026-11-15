/**
 * Pure module installation state machine.
 *
 * The native installer owns files and signatures.  The renderer keeps this
 * small, serialisable projection so the module store can render progress and
 * recover its view after a restart without making UI components responsible
 * for lifecycle rules.  All transitions are explicit and invalid transitions
 * fail with a stable error.
 */

export type ModuleLifecycle = "installed" | "enabled" | "disabled" | "uninstalled" | "rollback";

export interface ModuleRecord {
  slug: string;
  version: string;
  activeVersion?: string;
  previousVersion?: string;
  lifecycle: ModuleLifecycle;
  /** Uninstall never deletes data unless the user explicitly asks for it. */
  dataRetained: boolean;
  error?: string;
}

export interface ModuleStoreState {
  records: Record<string, ModuleRecord>;
  revision: number;
}

export type ModuleTransition =
  | { type: "install"; version: string }
  | { type: "enable" }
  | { type: "disable" }
  | { type: "uninstall"; deleteData?: boolean }
  | { type: "begin-rollback" }
  | { type: "complete-rollback"; version: string; lifecycle?: "enabled" | "disabled" | "installed" }
  | { type: "fail"; error: string };

export class ModuleStoreError extends Error {
  public constructor(message: string, public readonly slug: string) {
    super(message);
    this.name = "ModuleStoreError";
  }
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new ModuleStoreError(`Invalid module slug: ${slug}`, slug);
}

function assertVersion(version: string, slug: string): void {
  if (!VERSION.test(version)) throw new ModuleStoreError(`Invalid module version: ${version}`, slug);
}

function clone(record: ModuleRecord): ModuleRecord {
  return { ...record };
}

/** Apply one lifecycle event without side effects or filesystem access. */
export function transitionModule(record: ModuleRecord | undefined, slug: string, event: ModuleTransition): ModuleRecord {
  assertSlug(slug);
  if (event.type === "install") {
    assertVersion(event.version, slug);
    if (record && record.lifecycle !== "uninstalled" && record.lifecycle !== "rollback") {
      if (record.version === event.version && record.activeVersion === event.version) return clone(record);
    }
    return {
      slug,
      version: event.version,
      activeVersion: event.version,
      previousVersion: record?.activeVersion,
      lifecycle: "installed",
      dataRetained: record?.dataRetained ?? true,
    };
  }

  if (!record) throw new ModuleStoreError(`Module ${slug} is not installed`, slug);
  const current = clone(record);
  switch (event.type) {
    case "enable":
      if (current.lifecycle === "uninstalled" || current.lifecycle === "rollback") {
        throw new ModuleStoreError(`Module ${slug} cannot be enabled from ${current.lifecycle}`, slug);
      }
      current.lifecycle = "enabled";
      current.error = undefined;
      return current;
    case "disable":
      if (current.lifecycle === "uninstalled" || current.lifecycle === "rollback") {
        throw new ModuleStoreError(`Module ${slug} cannot be disabled from ${current.lifecycle}`, slug);
      }
      current.lifecycle = "disabled";
      current.error = undefined;
      return current;
    case "uninstall":
      if (current.lifecycle === "rollback") throw new ModuleStoreError(`Module ${slug} is rolling back`, slug);
      current.lifecycle = "uninstalled";
      current.dataRetained = !event.deleteData;
      current.previousVersion = current.activeVersion ?? current.version;
      current.activeVersion = undefined;
      current.error = undefined;
      return current;
    case "begin-rollback":
      if (!current.previousVersion) {
        throw new ModuleStoreError(`Module ${slug} has no rollback version`, slug);
      }
      current.lifecycle = "rollback";
      current.error = undefined;
      return current;
    case "complete-rollback":
      assertVersion(event.version, slug);
      if (current.lifecycle !== "rollback") throw new ModuleStoreError(`Module ${slug} is not rolling back`, slug);
      if (current.previousVersion !== event.version) {
        throw new ModuleStoreError(`Module ${slug} rollback version is unavailable`, slug);
      }
      current.previousVersion = current.activeVersion ?? current.version;
      current.activeVersion = event.version;
      current.version = event.version;
      current.lifecycle = event.lifecycle ?? "disabled";
      current.error = undefined;
      current.dataRetained = true;
      return current;
    case "fail":
      current.error = event.error;
      return current;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function reduceModuleStore(state: ModuleStoreState, slug: string, event: ModuleTransition): ModuleStoreState {
  const next = transitionModule(state.records[slug], slug, event);
  return { records: { ...state.records, [slug]: next }, revision: state.revision + 1 };
}

export function createModuleStoreState(records: ModuleRecord[] = []): ModuleStoreState {
  const mapped: Record<string, ModuleRecord> = {};
  for (const record of records) {
    assertSlug(record.slug);
    mapped[record.slug] = clone(record);
  }
  return { records: mapped, revision: 0 };
}

