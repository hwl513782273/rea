import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDirectAnalysis } from "../../src/application/DirectAnalysis.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../src/application/AnalysisProvider.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import { ok } from "../../src/domain/result.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../../src/application/binary/AnalysisSnapshotFiles.js";
import { createEvidence, type Evidence } from "../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../../src/application/InvestigationProviders.js";
import {
  createAnalysisSnapshotWorkflowEntry,
  type AnalysisSnapshot,
} from "../../src/domain/analysisSnapshot.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { BinarySession } from "../../src/application/binary/BinarySession.js";
import { SessionProviderRouter } from "../../src/application/binary/SessionProviderRouter.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const IDENTITY = {
  id: "snapshot-fixture",
  name: "Snapshot Fixture Provider",
  version: "1",
} as const;

const operations = [
  "list_segments",
  "list_documents",
  "list_procedures",
  "list_strings",
] as const;

const makeProvider = (
  starts: string[],
  calls: string[],
  profile = createAnalysisProfile(IDENTITY, { fixture: true }),
): AnalysisProvider => {
  const capabilities: CapabilityDescriptor[] = operations.map((operation) => ({
    operation,
    provider: IDENTITY,
    available: true,
    reason: null,
    cachePolicy: "snapshot",
    effects: {
      mutatesArtifact: false,
      launchesProcess: true,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  }));
  return {
    identity: () => IDENTITY,
    capabilities: () => capabilities,
    resolveAnalysisProfile: async () => ok({ profile, compatibility: {} }),
    createClient: () => {
      starts.push("start");
      return {
        execute: async (operation) => {
          calls.push(operation);
          const result =
            {
              list_segments: [
                { name: "__TEXT", start: "0x1000", end: "0x2000" },
              ],
              list_documents: ["fixture"],
              list_procedures: ["0x1000"],
              list_strings: { "0x1000": "fixture" },
            }[operation as (typeof operations)[number]] ?? null;
          return ok(
            createAnalysisExecution(result, IDENTITY, {
              analysisProfile: profile,
              rawResult: result,
            }),
          );
        },
        close: async () => undefined,
      };
    },
  };
};

const withAlternateWorkflowProfile = (
  snapshot: AnalysisSnapshot,
  path: string,
  current: Evidence,
): AnalysisSnapshot => {
  const alternateProfile = createAnalysisProfile(REA_WORKFLOW_PROVIDER, {
    workflow: "binary_overview",
    fixture: "alternate-profile",
  });
  const subject = {
    path,
    sha256: snapshot.target.sha256,
    format: snapshot.target.format,
    ...(snapshot.target.architecture === null
      ? {}
      : { architecture: snapshot.target.architecture }),
  };
  const alternateEvidence = createEvidence(subject, REA_WORKFLOW_PROVIDER, {
    operation: current.operation,
    parameters: current.parameters,
    result: current.normalized_result,
    rawResult: current.raw_result,
    analysisProfile: alternateProfile,
    confidence: "derived",
    limitations: current.limitations,
    locations: current.locations,
  });
  const alternateEntry = createAnalysisSnapshotWorkflowEntry({
    target: snapshot.target,
    binding: snapshot.binding,
    operation: current.operation,
    parameters: current.parameters,
    execution: {
      result: current.normalized_result,
      rawResult: current.raw_result,
      provider: REA_WORKFLOW_PROVIDER,
      analysisProfile: alternateProfile,
      limitations: current.limitations,
      locations: current.locations,
      subject,
    },
  });
  return {
    ...snapshot,
    workflow_entries: [alternateEntry],
    evidence_bundle: createEvidenceBundle([
      ...snapshot.evidence_bundle.records,
      alternateEvidence,
    ]),
  };
};

const withEarlierHistoricalEvidence = (
  snapshot: AnalysisSnapshot,
  path: string,
  current: Evidence,
): AnalysisSnapshot => {
  const older = Array.from({ length: 64 }, (_, index) =>
    createEvidence(
      {
        path,
        sha256: snapshot.target.sha256,
        format: "analysis-database",
      },
      REA_WORKFLOW_PROVIDER,
      {
        operation: "binary_overview",
        parameters: {},
        result: `historical-${index}`,
        analysisProfile: workflowAnalysisProfile(
          snapshot.binding.analysis_profile,
        ),
        confidence: "derived",
        limitations: ["Derived by an REA composed workflow."],
      },
    ),
  ).find((record) => record.evidence_id < current.evidence_id);
  if (older === undefined)
    throw new Error("fixture could not construct earlier historical Evidence");
  return {
    ...snapshot,
    evidence_bundle: createEvidenceBundle([
      ...snapshot.evidence_bundle.records,
      older,
    ]),
  };
};

describe("direct analysis composed snapshot replay", () => {
  it("replays the identical binary overview without provider startup or calls", async () => {
    const directory = await createTestTempDirectory("rea-workflow-snapshot-");
    const path = join(directory, "fixture.hop");
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(path, "fixture");
    const starts: string[] = [];
    const calls: string[] = [];
    const provider = makeProvider(starts, calls);
    const dependencies: DirectAnalysisDependencies = {
      createBinarySession: () => createTestBinarySession(provider),
      createManagedBinarySession: () => createTestBinarySession(provider),
    };

    const first = await runDirectAnalysis(
      dependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath },
    );
    expect(calls).toEqual(["health", ...operations]);
    expect(starts).toHaveLength(1);

    const loaded = await readAnalysisSnapshot(snapshotPath);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.workflow_entries).toHaveLength(1);
    const current = loaded.value.evidence_bundle.records.find(
      (record) => record.operation === "binary_overview",
    );
    if (current === undefined)
      throw new Error("composed Evidence was not saved");
    expect(
      (
        await writeAnalysisSnapshot(
          withEarlierHistoricalEvidence(loaded.value, path, current),
          snapshotPath,
          true,
        )
      ).ok,
    ).toBe(true);

    const second = await runDirectAnalysis(
      dependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath },
    );
    expect(second).toEqual(first);
    expect(calls).toEqual(["health", ...operations]);
    expect(starts).toHaveLength(1);
  });

  it("does not replay a valid entry from another workflow profile", async () => {
    const directory = await createTestTempDirectory("rea-workflow-profile-");
    const path = join(directory, "fixture.hop");
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(path, "fixture");
    const starts: string[] = [];
    const calls: string[] = [];
    const provider = makeProvider(starts, calls);
    const dependencies: DirectAnalysisDependencies = {
      createBinarySession: () => createTestBinarySession(provider),
      createManagedBinarySession: () => createTestBinarySession(provider),
    };
    await runDirectAnalysis(
      dependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath },
    );
    const loaded = await readAnalysisSnapshot(snapshotPath);
    if (!loaded.ok) throw loaded.error;
    const current = loaded.value.evidence_bundle.records.find(
      (record) => record.operation === "binary_overview",
    );
    if (current === undefined)
      throw new Error("composed Evidence was not saved");
    expect(
      (
        await writeAnalysisSnapshot(
          withAlternateWorkflowProfile(loaded.value, path, current),
          snapshotPath,
          true,
        )
      ).ok,
    ).toBe(true);

    await runDirectAnalysis(
      dependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath },
    );
    expect(calls).toEqual(["health", ...operations, "health", ...operations]);
    expect(starts).toHaveLength(2);
  });

  it("does not return a cached result when cancelled during route resolution", async () => {
    const directory = await createTestTempDirectory("rea-workflow-cancel-");
    const path = join(directory, "fixture.hop");
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(path, "fixture");
    const starts: string[] = [];
    const calls: string[] = [];
    const profile = createAnalysisProfile(IDENTITY, { fixture: true });
    const provider = makeProvider(starts, calls, profile);
    const initialDependencies: DirectAnalysisDependencies = {
      createBinarySession: () => createTestBinarySession(provider),
      createManagedBinarySession: () => createTestBinarySession(provider),
    };
    await runDirectAnalysis(
      initialDependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath },
    );

    const controller = new AbortController();
    const router = SessionProviderRouter.single(provider);
    const resolve = router.resolve.bind(router);
    router.resolve = async (...arguments_) => {
      const resolved = await resolve(...arguments_);
      controller.abort();
      return resolved;
    };
    const session = new BinarySession(router);
    const dependencies: DirectAnalysisDependencies = {
      createBinarySession: () => session,
      createManagedBinarySession: () => session,
    };
    const result = await runDirectAnalysis(
      dependencies,
      path,
      "binary_overview",
      {},
      { snapshotPath, signal: controller.signal },
    );

    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "cancelled",
    });
    expect(calls).toEqual(["health", ...operations]);
    expect(starts).toHaveLength(1);
  });
});
