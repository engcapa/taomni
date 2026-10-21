import { homedir, tmpdir } from "node:os";
import { FIXTURE_ROOT } from "./paths.mjs";


// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

export function makeSanitizer(projectDir) {
  const homes = [homedir(), tmpdir()];
  return (value) => {
    if (typeof value === "string") {
      let out = value.replaceAll(projectDir, "${project}");
      out = out.replaceAll(FIXTURE_ROOT, "${fixtures}");
      for (const home of homes) out = out.replaceAll(home, "~");
      return out;
    }
    if (Array.isArray(value)) return value.map(makeSanitizer(projectDir));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, makeSanitizer(projectDir)(inner)]));
    }
    return value;
  };
}
