import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


export const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");

export const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");

export const TRACES_DIR = join(FIXTURE_ROOT, "traces");
