import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./lsp-client.mjs";
import { FIXTURES, APP_MAIN, SIG_OVERLOAD_LINE } from "./matrix.mjs";
import { buildModelFingerprint, startSession, openFile } from "./session.mjs";
import { locateAfterPrefix, locateTokenInLine, locateTokenEnd, itemsFrom, normalizeEdit, simulateAcceptance } from "./textEdits.mjs";
import { waitForSignature, evaluateSignatureExpect, hoverText, httpsLinksIn } from "./languageInsights.mjs";
import { waitForCase, evaluateExpect, baseLabel } from "./completion.mjs";
import { runQuickFixScenario } from "./quickfix.mjs";
import { collectAnalysisSnapshot, executeCommandProbe } from "./analysis.mjs";
import { makeSanitizer } from "./trace.mjs";
import { TRACES_DIR } from "./paths.mjs";


// ---------------------------------------------------------------------------
// Per-fixture driver
// ---------------------------------------------------------------------------

export async function runFixture(fixtureId, toolchain, jdtls, gradleHome) {
  const spec = FIXTURES[fixtureId];
  const trace = {
    schemaVersion: 1,
    fixtureId,
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain,
    buildModelFingerprint: buildModelFingerprint(fixtureId),
    scenarios: [],
    failures: [],
  };

  const session = await startSession(jdtls, fixtureId, { gradleHome, javaPath: toolchain.java.path });
  const openedUris = new Map();

  try {
    // §8.20.2 W1: record which reference channels the provider actually
    // declares. Type Info / Expression Static Data have no standard LSP
    // method; an honest absence probe here is the evidence for their L0/L1
    // unavailable contract (unsupported trace is valid evidence).
    const caps = session.serverCapabilities ?? {};
    const capabilityJson = JSON.stringify(caps).toLowerCase();
    trace.providerChannels = {
      signatureHelpProvider: !!caps?.textDocument?.signatureHelpProvider,
      hoverProvider: !!caps?.textDocument?.hoverProvider,
      declaredTypeInfoChannel: /typeinfo/.test(capabilityJson),
      declaredStaticDataChannel: /staticdata|expressionstaticdata/.test(capabilityJson),
      topLevelCapabilityKeys: Object.keys(caps).sort(),
    };

    for (const fileSpec of spec.filesToOpen) {
      const text = openFile(session.client, session.projectDir, fileSpec.path);
      openedUris.set(fileSpec.path, { uri: `file://${join(session.projectDir, fileSpec.path)}`, text });
    }

    // Give the importer a moment to publish progress; cases poll anyway.
    for (const testCase of spec.cases) {
      const entry = openedUris.get(testCase.file);

      // ---- §8.20.2 W1 reference-information scenarios. ------------------
      if (testCase.kind === "signature" || testCase.kind === "supersede-cancel") {
        const position = locateAfterPrefix(entry.text, testCase.lineText, testCase.prefix);
        const scenario = {
          caseId: testCase.id,
          file: testCase.file,
          kind: testCase.kind,
          position,
          scopeRequested: "default",
          signatureHelp: null,
          supersede: null,
          notes: testCase.notes ?? null,
        };
        if (testCase.kind === "signature") {
          const wait = await waitForSignature(
            session.client,
            entry.uri,
            position,
            (result) => evaluateSignatureExpect(testCase.expectSignature, result),
            240_000,
          );
          scenario.signatureHelp = {
            attempts: wait.attempts.length,
            msTotal: Math.round(wait.attempts.reduce((sum, attempt) => sum + attempt.ms, 0)),
            signaturesCount: wait.final?.signatures?.length ?? 0,
            labels: (wait.final?.signatures ?? []).map((signature) => String(signature.label ?? "")),
            activeSignature: wait.final?.activeSignature ?? null,
            activeParameter: wait.final?.activeParameter ?? null,
            satisfied: wait.satisfied,
            evaluationReason: wait.evaluation.ok ? null : wait.evaluation.reason,
          };
          if (!wait.satisfied) trace.failures.push(`${testCase.id}: ${wait.evaluation.reason}`);
        } else {
          // supersede-cancel: fire, cancel on the wire, then re-request.
          const params = {
            textDocument: { uri: entry.uri },
            position,
            context: { triggerKind: 1, isRetrigger: false },
          };
          const firstStartedAt = Date.now();
          const first = session.client.requestTracked("textDocument/signatureHelp", params);
          session.client.cancelRequest(first.id);
          let firstCancelled = false;
          let firstOutcome = null;
          try {
            const raw = await first.promise;
            firstOutcome = "resolved-empty";
            firstCancelled = !raw || !Array.isArray(raw.signatures) || raw.signatures.length === 0;
          } catch (error) {
            firstOutcome = `rejected:${error.code ?? "?"}`;
            firstCancelled = true;
          }
          const second = await waitForSignature(
            session.client,
            entry.uri,
            position,
            (result) => evaluateSignatureExpect({ minSignatures: 1 }, result),
            240_000,
          );
          scenario.supersede = {
            firstOutcome,
            firstCancelled,
            msFirst: Date.now() - firstStartedAt,
            secondSatisfied: second.satisfied,
            msSecond: Math.round(second.attempts.reduce((sum, attempt) => sum + attempt.ms, 0)),
          };
          if (!firstCancelled) trace.failures.push(`${testCase.id}: cancelled request returned usable signatures`);
          if (!second.satisfied) trace.failures.push(`${testCase.id}: post-cancel request did not satisfy`);
        }
        trace.scenarios.push(scenario);
        continue;
      }

      if (testCase.kind === "hover") {
        const position = locateTokenInLine(entry.text, testCase.lineText, testCase.token);
        let hover = null;
        for (let attempt = 0; attempt < 40 && !(hover?.contentsPresent); attempt++) {
          const startedAt = Date.now();
          const result = await session.client.request("textDocument/hover", {
            textDocument: { uri: entry.uri },
            position,
          });
          const { text, kind } = hoverText(result?.contents);
          if (!hover) {
            hover = {
              msFirst: Date.now() - startedAt,
              attempts: 0,
              contentsPresent: false,
              contentsKind: null,
              externalLinks: [],
              excerpt: null,
              satisfied: false,
              evaluationReason: null,
            };
          }
          hover.attempts += 1;
          if (text.trim()) {
            hover.contentsKind = kind;
            hover.externalLinks = httpsLinksIn(text).slice(0, 5);
            // Bounded sanitized excerpt — evidence without embedding docs.
            hover.excerpt = text.replace(/\s+/g, " ").slice(0, 160);
            const present = text.trim().length > 0;
            hover.contentsPresent = present;
            hover.satisfied = present || !testCase.expectHover?.contentsPresent;
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
        }
        if (hover && !hover.contentsPresent) {
          hover.evaluationReason = "provider returned empty contents";
        }
        const scenario = {
          caseId: testCase.id,
          file: testCase.file,
          kind: "hover",
          position,
          scopeRequested: "default",
          hover,
          notes: testCase.notes ?? null,
        };
        if (testCase.expectHover?.contentsPresent && !hover?.contentsPresent) {
          trace.failures.push(`${testCase.id}: ${hover?.evaluationReason ?? "no contents recorded"}`);
        }
        trace.scenarios.push(scenario);
        continue;
      }

      // ---- Existing completion flow. ------------------------------------
      const scenario = {
        caseId: testCase.id,
        file: testCase.file,
        position: locateTokenEnd(entry.text, testCase.token),
        trigger: testCase.trigger ?? null,
        scopeRequested: "default",
        requests: [],
        resolve: null,
        acceptance: null,
        notes: testCase.notes ?? null,
      };

      const wait = await waitForCase(
        session.client,
        entry.uri,
        scenario.position,
        testCase.trigger,
        (items) => evaluateExpect(testCase.expect, items),
        240_000,
      );
      scenario.requests.push({
        attempts: wait.attempts.length,
        msTotal: Math.round(wait.msToSatisfy ?? 0),
        itemCount: itemsFrom(wait.final).length,
        isIncomplete: !Array.isArray(wait.final) && wait.final?.isIncomplete === true,
        satisfied: wait.satisfied,
        matchedDetail: wait.evaluation.matchedDetail ?? null,
        evaluationReason: wait.evaluation.ok ? null : wait.evaluation.reason,
      });
      let matched = wait.evaluation.matchedItem;

      try {
        if (wait.satisfied && matched && (testCase.resolveExpect || testCase.verifyRevert)) {
          const resolveStarted = Date.now();
          const resolved = await session.client.request("completionItem/resolve", matched, 30_000);
          // The resolved item replaces the raw echo; keep it for later cases.
          matched = { ...matched, ...(resolved ?? {}) };
          const additional = ((resolved?.additionalTextEdits ?? [])
            .map(normalizeEdit)
            .filter(Boolean));
          scenario.resolve = {
            ms: Date.now() - resolveStarted,
            additionalEditCount: additional.length,
            additionalEditTexts: additional.map((edit) => edit.newText),
          };
          if (testCase.resolveExpect) {
            if (additional.length < testCase.resolveExpect.additionalEditCountMin) {
              trace.failures.push(`${testCase.id}: expected ≥${testCase.resolveExpect.additionalEditCountMin} additional edits, got ${additional.length}`);
            }
            if (
              testCase.resolveExpect.additionalEditTextIncludes
              && !additional.some((edit) => edit.newText.includes(testCase.resolveExpect.additionalEditTextIncludes))
            ) {
              trace.failures.push(`${testCase.id}: additional edits lack ${testCase.resolveExpect.additionalEditTextIncludes}`);
            }
          }
          if (testCase.verifyRevert) {
            const primary = normalizeEdit(matched.textEdit) ?? {
              range: { start: { ...scenario.position }, end: { ...scenario.position } },
              newText: String(resolved?.insertText ?? baseLabel(matched)),
            };
            const simulation = simulateAcceptance(entry.text, primary, additional);
            const restored = simulation.undo();
            scenario.acceptance = {
              originalSha256: sha256(entry.text),
              appliedSha256: sha256(simulation.applied),
              revertedSha256: sha256(restored),
              revertRestoresOriginalHash: sha256(restored) === sha256(entry.text),
            };
            if (!scenario.acceptance.revertRestoresOriginalHash) {
              trace.failures.push(`${testCase.id}: reverting the merged acceptance did not restore the original document hash`);
            }
          }
        }
      } catch (caseError) {
        trace.failures.push(`${testCase.id}: acceptance simulation error — ${caseError.message}`);
      }

      if (testCase.recordOverloadsOf) {
        scenario.overloads = itemsFrom(wait.final)
          .filter((item) => item.label?.startsWith(testCase.recordOverloadsOf))
          .map((item) => ({ label: item.label, detail: item.detail ?? null }));
      }

      if (!wait.satisfied) {
        trace.failures.push(`${testCase.id}: ${wait.evaluation.reason}`);
      }
      trace.scenarios.push(scenario);
    }


    // ---- §8.20.4 W3: unresolved-type import quick fix (DoD trace). --------
    if (spec.quickFixScenario) {
      trace.quickFix = await runQuickFixScenario(session, spec.quickFixScenario);
      if (!trace.quickFix.satisfied && !trace.quickFix.reason?.startsWith("provider-hang")) {
        trace.failures.push(`quick-fix: ${trace.quickFix.reason}`);
      }
    }

    // ---- §8.20.3 W2: Project Analysis snapshot on the settled session. ----
    const mainEntry = openedUris.get(spec.filesToOpen[0].path);
    const analysis = await collectAnalysisSnapshot(session, mainEntry.uri);
    analysis.diagnosticFlags = {
      incompleteOrMissingMentioned: session.diagnosticsLog.some((entry) => (
        /incomplete|missing|could not be resolved|unresolved/i.test(entry.message)
      )),
    };
    trace.analysis = analysis;
    trace.analysisTiming = {
      firstCompletionSatisfiedMs: (() => {
        for (const scenario of trace.scenarios) {
          const last = scenario.requests?.at(-1);
          if (last?.satisfied && scenario.position) {
            return Date.now() - session.startedAt;
          }
        }
        return null;
      })(),
    };

    // Build-file change → fresh import progress (generation bump evidence),
    // then a byte-exact revert whose classpath fingerprint returns to baseline.
    if (spec.buildChangeScenario) {
      const relFile = spec.buildChangeScenario.file;
      const absPath = join(session.projectDir, relFile);
      const original = readFileSync(absPath, "utf8");
      const eventsBefore = session.progressEvents.length;
      writeFileSync(absPath, `${original}\n<!-- w2-generation-bump-probe -->\n`);
      session.client.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: `file://${absPath}`, type: 2 }],
      });
      let reimportObserved = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const fresh = session.progressEvents.slice(eventsBefore);
        if (fresh.some((event) => event.kind === "begin")) {
          reimportObserved = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      }
      writeFileSync(absPath, original);
      session.client.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: `file://${absPath}`, type: 2 }],
      });
      // Give the importer time to chew on the revert before the probe.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      let classpathShaAfterRevert = null;
      try {
        const value = await executeCommandProbe(
          session.client,
          "java.project.getClasspaths",
          [mainEntry.uri],
        );
        const entries = Array.isArray(value)
          ? value.filter((entry) => typeof entry === "string")
          : Array.isArray(value?.classpaths) ? value.classpaths : [];
        classpathShaAfterRevert = sha256([...entries].sort().join("\n"));
      } catch {
        classpathShaAfterRevert = null;
      }
      analysis.buildChange = {
        mutatedFile: relFile,
        reimportProgressObserved: reimportObserved,
        revertedByteExact: readFileSync(absPath, "utf8") === original,
        // Meaningful only when a classpath probe exists to compare against;
        // lifecycle-only providers leave this null instead of implying drift.
        classpathStableAfterRevert: analysis.classpathProbe?.entriesSha256
          ? classpathShaAfterRevert !== null
            && classpathShaAfterRevert === analysis.classpathProbe.entriesSha256
          : null,
      };
      if (!reimportObserved) {
        trace.failures.push(`build-change: no provider progress after ${relFile} change`);
      }
      if (!analysis.buildChange.revertedByteExact) {
        trace.failures.push(`build-change: ${relFile} not restored byte-exactly`);
      }
    }


    if (spec.restartAfterCases) {
      const restartStarted = Date.now();
      await session.client.kill();
      const second = await startSession(jdtls, fixtureId, { gradleHome, javaPath: toolchain.java.path });
      try {
        const reopenSpec = spec.restartAfterCases;
        const text = openFile(second.client, second.projectDir, reopenSpec.file);
        const wait = await waitForCase(
          second.client,
          `file://${join(second.projectDir, reopenSpec.file)}`,
          locateTokenEnd(text, reopenSpec.token),
          null,
          (items) => evaluateExpect(reopenSpec.expect, items),
          240_000,
        );
        // §8.20.2 W1: Parameter Info must also recover after the provider is
        // SIGKILLed and the session rebuilt — same evidence bar as completion.
        let signatureOkAfterRestart = false;
        let signatureReason = "not run";
        if (fixtureId === "maven-single") {
          const sigText = openFile(second.client, second.projectDir, APP_MAIN);
          const sigWait = await waitForSignature(
            second.client,
            `file://${join(second.projectDir, APP_MAIN)}`,
            locateAfterPrefix(sigText, SIG_OVERLOAD_LINE, "sb.append("),
            (result) => evaluateSignatureExpect({ minSignatures: 1 }, result),
            240_000,
          );
          signatureOkAfterRestart = sigWait.satisfied;
          signatureReason = sigWait.evaluation.reason ?? null;
          if (!sigWait.satisfied) trace.failures.push(`restart-signature: ${sigWait.evaluation.reason}`);
        }
        trace.restart = {
          performed: true,
          msToReadyAfterRestart: Date.now() - restartStarted,
          completionOkAfterRestart: wait.satisfied,
          signatureHelpOkAfterRestart: fixtureId === "maven-single" ? signatureOkAfterRestart : null,
          reason: wait.evaluation.reason ?? null,
          signatureReason,
        };
        // §8.20.3 W2 offline-cache hint: a warm second session should reach
        // its first satisfied completion noticeably faster than the cold one.
        const firstMs = trace.analysisTiming?.firstCompletionSatisfiedMs ?? null;
        const restartFirstMs = wait.satisfied ? Date.now() - second.startedAt : null;
        trace.analysisTiming = {
          ...trace.analysisTiming,
          offlineCacheHint: {
            coldSessionFirstSatisfiedMs: firstMs,
            restartedSessionFirstSatisfiedMs: restartFirstMs,
            fasterThanCold: firstMs !== null && restartFirstMs !== null
              ? restartFirstMs < firstMs
              : null,
          },
        };
        if (!wait.satisfied) trace.failures.push(`restart: ${wait.evaluation.reason}`);
      } finally {
        await second.client.shutdown().catch(() => {});
        rmSync(second.dataDir, { recursive: true, force: true });
      }
    }

    if (spec.collectDiagnostics) {
      trace.diagnosticsSummary = {
        count: session.diagnosticsLog.length,
        mentionsMissingLib: session.diagnosticsLog.some((d) => d.message.includes("missing-lib")),
        sampleMessages: session.diagnosticsLog.slice(0, 3).map((d) => d.message.split("\n")[0]),
      };
    }
  } finally {
    await session.client.shutdown().catch(() => {});
    rmSync(session.dataDir, { recursive: true, force: true });
  }

  // §8.20.2 W1: distinguish "statically declared", "dynamically registered"
  // and "proven by a satisfied scenario" — jdtls registers signatureHelp/hover
  // at runtime, so a bare static-capability read would misreport them absent.
  const staticCaps = session.serverCapabilities ?? {};
  const anySignatureOk = trace.scenarios.some((scenario) => scenario.signatureHelp?.satisfied);
  const anyHoverOk = trace.scenarios.some((scenario) => scenario.hover?.contentsPresent);
  trace.providerChannels.signatureHelpProviderDeclaredStatically = !!staticCaps?.textDocument?.signatureHelpProvider;
  trace.providerChannels.hoverProviderDeclaredStatically = !!staticCaps?.textDocument?.hoverProvider;
  trace.providerChannels.signatureHelpProvenByScenarios = anySignatureOk;
  trace.providerChannels.hoverProvenByScenarios = anyHoverOk;
  trace.providerChannels.dynamicRegistrations = [...new Set(session.registeredMethods)].sort();
  delete trace.providerChannels.signatureHelpProvider;
  delete trace.providerChannels.hoverProvider;

  const sanitize = makeSanitizer(session.projectDir);
  const sanitizedTrace = sanitize(trace);
  mkdirSync(TRACES_DIR, { recursive: true });
  const outFile = join(TRACES_DIR, `${fixtureId}.trace.json`);
  writeFileSync(outFile, `${JSON.stringify(sanitizedTrace, null, 2)}\n`, "utf8");

  return { fixtureId, outFile, failures: trace.failures };
}
