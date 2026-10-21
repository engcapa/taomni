import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { FIXTURES } from "./matrix.mjs";
import { resolveJava, javaVersion, resolveJdtlsHome, resolveGradleDist } from "./toolchain.mjs";
import { runFixture } from "./runFixture.mjs";


// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const requested = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture") requested.push(args[++i]);
  }
  const fixtureIds = requested.length > 0 ? requested : Object.keys(FIXTURES);

  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  if (javaInfo.major < 17) throw new Error(`jdtls needs Java 17+; got ${javaInfo.line}`);
  const jdtls = resolveJdtlsHome();
  const gradle = resolveGradleDist();
  const mvnVersion = (() => {
    for (const mvn of ["/data/dev/maven/bin/mvn", "mvn"]) {
      try {
        const out = execFileSync(mvn, ["-version"], { encoding: "utf8" });
        return out.split("\n")[0]?.trim() ?? null;
      } catch {
        continue;
      }
    }
    return null;
  })();

  const toolchain = {
    java: { path: javaPath.replace(homedir(), "~"), version: javaInfo.version, info: javaInfo },
    jdtls: { home: "${JDTLS_HOME}", version: jdtls.version },
    gradle: gradle ? { version: gradle.version, home: gradle.home.replace(homedir(), "~") } : null,
    mavenCliDetected: mvnVersion,
  };
  console.log("toolchain:", JSON.stringify(toolchain));

  const results = [];
  for (const fixtureId of fixtureIds) {
    if (!FIXTURES[fixtureId]) throw new Error(`unknown fixture ${fixtureId}`);
    console.log(`\n=== ${fixtureId} ===`);
    const outcome = await runFixture(fixtureId, toolchain, jdtls, gradle?.home ?? null);
    console.log(`trace: ${outcome.outFile}`);
    if (outcome.failures.length > 0) {
      console.log(`FAILURES (${outcome.failures.length}):`);
      for (const failure of outcome.failures) console.log(`  - ${failure}`);
    } else {
      console.log("all cases green");
    }
    results.push(outcome);
  }

  const failed = results.filter((result) => result.failures.length > 0);
  console.log(`\n${results.length - failed.length}/${results.length} fixtures green`);
  if (failed.length > 0) process.exitCode = 1;
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
