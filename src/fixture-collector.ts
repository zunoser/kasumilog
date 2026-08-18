import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  commitAndPushArchivePaths,
  verifyRemoteRawPage,
  verifyRemoteRawRun,
  type ArchiveGitTarget,
} from "./archive-git.ts";
import {
  readRawCapture,
  readRawRunManifest,
  storeRawCapture,
  storeRawRun,
  type RawCaptureInput,
  type RawCaptureResponse,
  type RawCoverageFrontier,
  type RawRunStatus,
  type RawRunStopReason,
  type RawRunInput,
} from "./raw.ts";

interface FixtureResponse extends Omit<RawCaptureResponse, "body"> {
  readonly bodyFile: string;
}

interface FixtureCapture extends Omit<RawCaptureInput, "response"> {
  readonly response: FixtureResponse;
}

export interface FixtureRun {
  readonly status: RawRunStatus;
  readonly stopReason: RawRunStopReason;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly coverageFrontier?: RawCoverageFrontier;
}

export interface CaptureFixture {
  readonly schemaVersion: 1;
  readonly capture: FixtureCapture;
  readonly run: FixtureRun;
}

export interface FixtureCollectionResult {
  readonly fetchId: string;
  readonly runId: string;
  readonly pageCommit: string;
  readonly runCommit: string;
  readonly idempotent: boolean;
}

export interface CollectFixtureOptions extends ArchiveGitTarget {
  readonly fixturePath: string;
}

function parseFixture(serialized: string): CaptureFixture {
  const fixture = JSON.parse(serialized) as Partial<CaptureFixture>;
  if (
    fixture.schemaVersion !== 1 ||
    !fixture.capture ||
    !fixture.run ||
    typeof fixture.capture.response?.bodyFile !== "string"
  ) {
    throw new Error("Invalid capture fixture");
  }
  return fixture as CaptureFixture;
}

function runInput(fixture: CaptureFixture, pageCommit: string): RawRunInput {
  return {
    runId: fixture.capture.runId,
    source: { kind: "list_timeline", listId: fixture.capture.listId },
    status: fixture.run.status,
    stopReason: fixture.run.stopReason,
    pages: [{
      page: 0,
      fetchId: fixture.capture.fetchId,
      verifiedCommit: pageCommit,
    }],
    ...(fixture.run.coverageFrontier
      ? { coverageFrontier: fixture.run.coverageFrontier }
      : {}),
    catalogRevision: fixture.capture.catalogRevision,
    listRevision: fixture.capture.listRevision,
    startedAt: fixture.run.startedAt,
    finishedAt: fixture.run.finishedAt,
    lastVerifiedPageCommit: pageCommit,
  };
}

export async function collectFixturePage(
  options: CollectFixtureOptions,
): Promise<FixtureCollectionResult> {
  const fixturePath = resolve(options.fixturePath);
  const fixture = parseFixture(await readFile(fixturePath, "utf8"));
  if (fixture.capture.page !== 0) {
    throw new Error("The fixture vertical slice supports exactly page 0");
  }
  const bodyPath = isAbsolute(fixture.capture.response.bodyFile)
    ? fixture.capture.response.bodyFile
    : join(dirname(fixturePath), fixture.capture.response.bodyFile);
  const body = await readFile(bodyPath);
  const { bodyFile: _bodyFile, ...response } = fixture.capture.response;
  const rawRoot = resolve(options.rawRoot);
  const stored = await storeRawCapture(rawRoot, {
    ...fixture.capture,
    response: {
      ...response,
      body,
    },
  });
  await readRawCapture(rawRoot, stored.manifest);

  const target: ArchiveGitTarget = options;
  const existingRun = await readRawRunManifest(rawRoot, fixture.capture.runId);
  if (existingRun) {
    const pageCommit = existingRun.manifest.pages.at(-1)?.verifiedCommit;
    if (!pageCommit) throw new Error("Existing run has no verified page commit");
    const canonicalRun = await storeRawRun(rawRoot, runInput(fixture, pageCommit));
    const runCommit = await commitAndPushArchivePaths(
      target,
      [canonicalRun.manifestPath],
      `archive run ${fixture.capture.runId}`,
    );
    const remoteRun = await verifyRemoteRawRun(
      target,
      runCommit.commit,
      canonicalRun.manifestPath,
    );
    if (remoteRun.pages[0]?.fetchId !== fixture.capture.fetchId) {
      throw new Error("Existing run manifest does not match the fixture");
    }
    return {
      fetchId: fixture.capture.fetchId,
      runId: fixture.capture.runId,
      pageCommit,
      runCommit: runCommit.commit,
      idempotent: true,
    };
  }

  const pageCommit = await commitAndPushArchivePaths(
    target,
    [stored.objectPath, stored.manifestPath],
    `archive page ${fixture.capture.runId}/0`,
  );
  const remotePage = await verifyRemoteRawPage(
    target,
    pageCommit.commit,
    stored.manifestPath,
  );
  if (remotePage.fetchId !== fixture.capture.fetchId) {
    throw new Error("Remote fetch manifest does not match the fixture");
  }

  const run = await storeRawRun(rawRoot, runInput(fixture, pageCommit.commit));
  const runCommit = await commitAndPushArchivePaths(
    target,
    [run.manifestPath],
    `archive run ${fixture.capture.runId}`,
  );
  await verifyRemoteRawRun(target, runCommit.commit, run.manifestPath);
  return {
    fetchId: fixture.capture.fetchId,
    runId: fixture.capture.runId,
    pageCommit: pageCommit.commit,
    runCommit: runCommit.commit,
    idempotent: false,
  };
}
