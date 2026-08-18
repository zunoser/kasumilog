import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRawCapture,
  recoverArchiveState,
  storeRawCapture,
  storeRawRun,
  type RawCaptureInput,
} from "../src/raw.ts";
import { RELAY_REQUEST_CATALOG_SOURCE } from "../src/relay.ts";

const sha = (character: string) => character.repeat(64);

function captureInput(fetchId: string, body: Uint8Array): RawCaptureInput {
  return {
    fetchId,
    runId: "run-1",
    page: 0,
    attempt: 1,
    listId: "list-1",
    catalogRevision: sha("a"),
    listRevision: sha("b"),
    requestedAt: "2026-08-18T00:00:00.000Z",
    receivedAt: "2026-08-18T00:00:01.000Z",
    request: {
      operation: "ListLatestTweetsTimeline",
      profileName: "account2",
      requestCatalog: {
        source: RELAY_REQUEST_CATALOG_SOURCE.htmlUrl,
        revision: "0".repeat(40),
        contentSha256: sha("c"),
        overridesSha256: sha("f"),
      },
      requestTemplateSha256: sha("d"),
      variablesSha256: sha("e"),
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Rate-Limit-Remaining": "99",
        "Set-Cookie": "auth=must-not-persist",
        "X-CSRF-Token": "must-not-persist",
        "X-Relay-Internal": "must-not-persist",
      },
      body,
    },
  };
}

test("raw captures preserve bytes, deduplicate bodies, and omit unsafe headers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);

  const first = await storeRawCapture(root, captureInput("fetch-1", body));
  const second = await storeRawCapture(root, captureInput("fetch-2", body));

  assert.equal(first.objectPath, second.objectPath);
  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.deepEqual(
    [...await readRawCapture(root, first.manifest)],
    [...body],
  );
  assert.deepEqual(first.manifest.response.headers, {
    "content-type": "application/json",
    "x-rate-limit-remaining": "99",
  });
  assert.deepEqual(first.manifest.response.excludedHeaderNames, [
    "set-cookie",
    "x-csrf-token",
    "x-relay-internal",
  ]);

  const serialized = await readFile(first.manifestPath, "utf8");
  assert.doesNotMatch(serialized, /must-not-persist/);
  assert.equal(JSON.parse(serialized).request.requestTemplateSha256, sha("d"));
  assert.equal(JSON.parse(serialized).request.profileName, "account2");
});

test("raw capture manifests and objects are immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await storeRawCapture(
    root,
    captureInput("fetch-1", Buffer.from("first", "utf8")),
  );

  await assert.rejects(
    storeRawCapture(root, captureInput("fetch-1", Buffer.from("second", "utf8"))),
    /Immutable file conflict/,
  );

  await writeFile(first.objectPath, Buffer.from("corrupt", "utf8"));
  await assert.rejects(
    readRawCapture(root, first.manifest),
    /Raw object verification failed/,
  );
});

test("only complete run manifests may advance coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await storeRawCapture(
    root,
    captureInput("fetch-1", Buffer.from("page", "utf8")),
  );
  const base = {
    runId: "run-1",
    source: { kind: "list_timeline" as const, listId: "list-1" },
    stopReason: "exhausted" as const,
    pages: [{ page: 0, fetchId: "fetch-1", verifiedCommit: "1".repeat(40) }],
    catalogRevision: sha("a"),
    listRevision: sha("b"),
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:02.000Z",
    lastVerifiedPageCommit: "1".repeat(40),
  };

  await assert.rejects(
    storeRawRun(root, { ...base, status: "complete" }),
    /complete run must include a coverage frontier/,
  );
  await assert.rejects(
    storeRawRun(root, {
      ...base,
      status: "partial",
      coverageFrontier: {
        publishedAt: "2026-08-18T00:00:00.000Z",
        tweetIds: ["123"],
      },
    }),
    /Only a complete run may advance/,
  );
});

test("request provenance rejects unknown fields at runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = captureInput("fetch-1", Buffer.from("page", "utf8"));
  Object.assign(input.request, {
    headers: { authorization: "must-not-persist" },
  });
  await assert.rejects(
    storeRawCapture(root, input),
    /Unexpected request fields: headers/,
  );
});

test("fetch and run IDs are unique across date partitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = captureInput("fetch-1", Buffer.from("page", "utf8"));
  await storeRawCapture(root, first);
  await assert.rejects(
    storeRawCapture(root, {
      ...first,
      requestedAt: "2026-08-19T00:00:00.000Z",
      receivedAt: "2026-08-19T00:00:01.000Z",
    }),
    /Fetch ID already exists at a different date/,
  );
  const run = {
    runId: "run-1",
    source: { kind: "list_timeline" as const, listId: "list-1" },
    status: "complete" as const,
    stopReason: "exhausted" as const,
    pages: [{ page: 0, fetchId: "fetch-1", verifiedCommit: "1".repeat(40) }],
    coverageFrontier: {
      publishedAt: "2026-08-18T00:00:00.000Z",
      tweetIds: ["123"],
    },
    catalogRevision: sha("a"),
    listRevision: sha("b"),
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:02.000Z",
    lastVerifiedPageCommit: "1".repeat(40),
  };
  await storeRawRun(root, run);
  await assert.rejects(
    storeRawRun(root, {
      ...run,
      finishedAt: "2026-08-19T00:00:02.000Z",
    }),
    /Run ID already exists at a different date/,
  );
});

test("archive recovery rejects a run whose fetch dimensions differ", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await storeRawCapture(root, captureInput("fetch-1", Buffer.from("page", "utf8")));
  const stored = await storeRawRun(root, {
    runId: "run-1",
    source: { kind: "list_timeline", listId: "list-1" },
    status: "complete",
    stopReason: "exhausted",
    pages: [{ page: 0, fetchId: "fetch-1", verifiedCommit: "1".repeat(40) }],
    coverageFrontier: {
      publishedAt: "2026-08-18T00:00:00.000Z",
      tweetIds: ["123"],
    },
    catalogRevision: sha("a"),
    listRevision: sha("b"),
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:02.000Z",
    lastVerifiedPageCommit: "1".repeat(40),
  });
  const tampered = JSON.parse(await readFile(stored.manifestPath, "utf8"));
  tampered.source.listId = "other-list";
  await writeFile(stored.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    recoverArchiveState(root),
    /Fetch manifest does not match run page/,
  );
});
