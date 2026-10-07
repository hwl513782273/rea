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
import { createEvidence } from "../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../../src/application/InvestigationProviders.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
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

const makeProvider = (starts: string[], calls: string[]): AnalysisProvider => {
  const profile = createAnalysisProfile(IDENTITY, { fixture: true });
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
    const older = Array.from({ length: 64 }, (_, index) =>
      createEvidence(
        {
          path,
          sha256: loaded.value.target.sha256,
          format: "analysis-database",
        },
        REA_WORKFLOW_PROVIDER,
        {
          operation: "binary_overview",
          parameters: {},
          result: `historical-${index}`,
          analysisProfile: workflowAnalysisProfile(
            loaded.value.binding.analysis_profile,
          ),
          confidence: "derived",
          limitations: ["Derived by an REA composed workflow."],
        },
      ),
    ).find((record) => record.evidence_id < current.evidence_id);
    if (older === undefined)
      throw new Error(
        "fixture could not construct earlier historical Evidence",
      );
    const withHistory = {
      ...loaded.value,
      evidence_bundle: createEvidenceBundle([
        ...loaded.value.evidence_bundle.records,
        older,
      ]),
    };
    expect(
      (await writeAnalysisSnapshot(withHistory, snapshotPath, true)).ok,
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
});
