import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectListTimeline,
  DEFAULT_COLLECTION_LIMITS,
  inspectTimelineResponse,
  runTimelineCollection,
  type TimelineCollectorDependencies,
} from "../src/collector.ts";
import { catalog } from "../src/catalog.ts";
import {
  recoverArchiveState,
  type RawCaptureResponse,
  type RawRunInput,
} from "../src/raw.ts";
import { createRelayRequestCatalog } from "../src/relay.ts";
import { RelayClientPolicyError } from "../src/relay-client.ts";

const relayCatalog = createRelayRequestCatalog([
  ["POST", "CreateList", { variables: {} }],
  ["GET", "ListMembers", JSON.stringify({ listId: "old", count: 20 })],
  ["POST", "ListAddMember", { variables: {} }],
  ["POST", "ListRemoveMember", { variables: {} }],
  ["GET", "ListLatestTweetsTimeline", JSON.stringify({ listId: "old", count: 40 })],
].map(([method, operation, variables]) => JSON.stringify({
  method,
  path: `/graphql/query/${operation}`,
  headers: { "content-type": "application/json" },
  ...(method === "GET"
    ? { params: { variables, features: "{}" } }
    : { data: variables }),
})).join("\n"), "0".repeat(40));

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

function tweetEntry(id: string, publishedAt: string, text = `tweet ${id}`) {
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: {
            rest_id: id,
            core: {
              user_results: {
                result: {
                  rest_id: "412940784",
                  legacy: { screen_name: "kantei" },
                },
              },
            },
            legacy: {
              created_at: new Date(publishedAt).toUTCString(),
              full_text: text,
            },
          },
        },
      },
    },
  };
}

function timelineResponse(
  posts: readonly { id: string; publishedAt: string }[],
  cursor?: string,
  status = 200,
  headers: Record<string, string> = {},
): RawCaptureResponse {
  const entries: unknown[] = posts.map(({ id, publishedAt }) => tweetEntry(id, publishedAt));
  if (cursor) {
    entries.push({
      entryId: "cursor-bottom",
      content: { cursorType: "Bottom", value: cursor },
    });
  }
  return {
    status,
    headers,
    body: Buffer.from(JSON.stringify({
      data: {
        list: {
          tweets_timeline: {
            timeline: {
              instructions: [{ type: "TimelineAddEntries", entries }],
            },
          },
        },
      },
    })),
  };
}

function harness(responses: Array<RawCaptureResponse | Error>, random = 0) {
  let now = Date.parse("2026-08-18T01:00:00.000Z");
  const events: string[] = [];
  const starts: number[] = [];
  const runs: RawRunInput[] = [];
  let captures = 0;
  const dependencies: TimelineCollectorDependencies = {
    now: () => now,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      now += milliseconds;
    },
    random: () => random,
    execute: async (request) => {
      const variables = JSON.parse(String(request.params?.variables));
      events.push(`execute:${variables.cursor ?? "head"}`);
      starts.push(now);
      const response = responses.shift();
      if (!response) throw new Error("No fake response");
      if (response instanceof Error) throw response;
      return response;
    },
    persistCapture: async (input) => {
      events.push(`persist:${input.page}:${input.attempt}`);
      captures += 1;
      return {
        page: input.page,
        fetchId: `fetch-${captures}`,
        verifiedCommit: String(captures).padStart(40, "0"),
      };
    },
    persistRun: async (run) => {
      events.push(`run:${run.status}:${run.stopReason}`);
      runs.push(run);
    },
  };
  return { dependencies, events, starts, runs };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    listId: "list-1",
    listRevision: "a".repeat(64),
    catalogRevision: "b".repeat(64),
    requestCatalog: relayCatalog,
    catalog,
    limits: {
      ...DEFAULT_COLLECTION_LIMITS,
      pacingJitterMs: 1,
      ...((overrides.limits as object | undefined) ?? {}),
    },
    ...overrides,
  } as Parameters<typeof runTimelineCollection>[0];
}

test("first collection seeds only the latest useful page", async () => {
  const fake = harness([
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "older"),
  ]);
  const result = await runTimelineCollection(options(), fake.dependencies);

  assert.equal(result.status, "complete");
  assert.equal(result.stopReason, "initial_seed");
  assert.equal(result.requests, 1);
  assert.deepEqual(result.coverageFrontier?.tweetIds, ["300"]);
  assert.deepEqual(fake.events, [
    "execute:head",
    "persist:0:1",
    "run:complete:initial_seed",
  ]);
});

test("first collection never follows a cursor when the head page is empty", async () => {
  const fake = harness([timelineResponse([], "older")]);
  const result = await runTimelineCollection(options(), fake.dependencies);
  assert.equal(result.requests, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "page_limit");
  assert.equal(result.coverageFrontier, undefined);
});

test("explicit bootstrap is bounded and persists before requesting the next page", async () => {
  const fake = harness([
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "cursor-a"),
    timelineResponse([{ id: "200", publishedAt: "2026-08-18T00:58:00.000Z" }], "cursor-b"),
  ]);
  const result = await runTimelineCollection(options({
    bootstrapFrom: "2026-08-17T00:00:00.000Z",
    limits: { maxTimelinePages: 2, pacingJitterMs: 1 },
  }), fake.dependencies);

  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "page_limit");
  assert.equal(result.coverageFrontier, undefined);
  assert.deepEqual(fake.starts.map((value) => value - fake.starts[0]), [0, 30_000]);
  assert.ok(fake.events.indexOf("persist:0:1") < fake.events.indexOf("execute:cursor-a"));
});

test("an old pinned entry does not satisfy the bootstrap boundary", async () => {
  const fake = harness([
    timelineResponse([
      { id: "100", publishedAt: "2020-01-01T00:00:00.000Z" },
      { id: "300", publishedAt: "2026-08-18T00:59:00.000Z" },
    ], "older"),
  ]);
  const result = await runTimelineCollection(options({
    bootstrapFrom: "2026-08-17T00:00:00.000Z",
    limits: { maxTimelinePages: 1, pacingJitterMs: 1 },
  }), fake.dependencies);
  assert.equal(result.status, "partial");
  assert.equal(result.stopReason, "page_limit");
});

test("previous frontier stops after overlap is proven", async () => {
  const fake = harness([
    timelineResponse([
      { id: "400", publishedAt: "2026-08-18T00:59:00.000Z" },
      { id: "300", publishedAt: "2026-08-18T00:58:00.000Z" },
      { id: "200", publishedAt: "2026-08-18T00:57:00.000Z" },
    ], "older"),
  ]);
  const result = await runTimelineCollection(options({
    previousFrontier: {
      publishedAt: "2026-08-18T00:58:00.000Z",
      tweetIds: ["300"],
    },
  }), fake.dependencies);

  assert.equal(result.status, "complete");
  assert.equal(result.stopReason, "frontier_reached");
  assert.deepEqual(result.coverageFrontier?.tweetIds, ["400"]);
});

test("an older timestamp proves overlap even when the frontier tweet disappeared", async () => {
  const fake = harness([
    timelineResponse([
      { id: "400", publishedAt: "2026-08-18T00:59:00.000Z" },
      { id: "200", publishedAt: "2026-08-18T00:57:00.000Z" },
    ], "older"),
  ]);
  const result = await runTimelineCollection(options({
    previousFrontier: {
      publishedAt: "2026-08-18T00:58:00.000Z",
      tweetIds: ["deleted-300"],
    },
  }), fake.dependencies);

  assert.equal(result.status, "complete");
  assert.equal(result.stopReason, "frontier_reached");
  assert.equal(result.requests, 1);
});

test("duplicate text does not stop collection without frontier overlap", async () => {
  const duplicateText = "定例記者会見";
  const first = timelineResponse([
    { id: "400", publishedAt: "2026-08-18T00:59:00.000Z" },
  ], "cursor-a");
  const second = timelineResponse([
    { id: "200", publishedAt: "2026-08-18T00:57:00.000Z" },
  ]);
  const firstPayload = JSON.parse(Buffer.from(first.body).toString("utf8"));
  const secondPayload = JSON.parse(Buffer.from(second.body).toString("utf8"));
  firstPayload.data.list.tweets_timeline.timeline.instructions[0].entries[0] =
    tweetEntry("400", "2026-08-18T00:59:00.000Z", duplicateText);
  secondPayload.data.list.tweets_timeline.timeline.instructions[0].entries[0] =
    tweetEntry("200", "2026-08-18T00:57:00.000Z", duplicateText);
  const fake = harness([
    { ...first, body: Buffer.from(JSON.stringify(firstPayload)) },
    { ...second, body: Buffer.from(JSON.stringify(secondPayload)) },
  ]);

  const result = await runTimelineCollection(options({
    previousFrontier: {
      publishedAt: "2026-08-18T00:58:00.000Z",
      tweetIds: ["300"],
    },
  }), fake.dependencies);

  assert.equal(result.requests, 2);
  assert.equal(result.status, "complete");
});

test("429 response is archived and Retry-After delays the retry", async () => {
  const fake = harness([
    timelineResponse([], undefined, 429, { "retry-after": "60" }),
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "older"),
  ]);
  const result = await runTimelineCollection(options(), fake.dependencies);

  assert.equal(result.status, "complete");
  assert.equal(result.requests, 2);
  assert.deepEqual(fake.starts.map((value) => value - fake.starts[0]), [0, 60_000]);
  assert.deepEqual(fake.events.filter((event) => event.startsWith("persist:")), [
    "persist:0:1",
    "persist:0:2",
  ]);
  assert.equal(fake.runs[0]?.pages.length, 1);
  assert.equal(fake.runs[0]?.pages[0]?.fetchId, "fetch-2");
});

test("HTTP-date Retry-After, recovered notBefore, and rate reset are honored", async () => {
  const base = Date.parse("2026-08-18T01:00:00.000Z");
  const retryDate = new Date(base + 90_000).toUTCString();
  const retry = harness([
    timelineResponse([], undefined, 429, { "retry-after": retryDate }),
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "older"),
  ]);
  await runTimelineCollection(options(), retry.dependencies);
  assert.deepEqual(retry.starts.map((value) => value - base), [0, 90_000]);

  const recovered = harness([
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "older"),
  ]);
  await runTimelineCollection(options({
    notBefore: new Date(base + 45_000).toISOString(),
  }), recovered.dependencies);
  assert.equal(recovered.starts[0], base + 45_000);

  const reset = harness([
    timelineResponse(
      [{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }],
      "cursor-a",
      200,
      {
        "x-rate-limit-remaining": "0",
        "x-rate-limit-reset": String((base + 120_000) / 1_000),
      },
    ),
    timelineResponse([{ id: "200", publishedAt: "2026-08-16T00:00:00.000Z" }]),
  ]);
  await runTimelineCollection(options({
    bootstrapFrom: "2026-08-17T00:00:00.000Z",
  }), reset.dependencies);
  assert.deepEqual(reset.starts.map((value) => value - base), [0, 120_000]);
});

test("503 uses bounded exponential jitter and a non-retryable 403 stops", async () => {
  const retry = harness([
    timelineResponse([], undefined, 503),
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "older"),
  ], 1);
  const retryResult = await runTimelineCollection(options(), retry.dependencies);
  assert.equal(retryResult.status, "complete");
  assert.deepEqual(retry.starts.map((value) => value - retry.starts[0]), [0, 60_000]);

  const forbidden = harness([timelineResponse([], undefined, 403)]);
  const forbiddenResult = await runTimelineCollection(options(), forbidden.dependencies);
  assert.equal(forbiddenResult.status, "failed");
  assert.equal(forbiddenResult.stopReason, "upstream_error");
  assert.equal(forbiddenResult.requests, 1);

  const policy = harness([new RelayClientPolicyError("unsupported response encoding")]);
  const policyResult = await runTimelineCollection(options(), policy.dependencies);
  assert.equal(policyResult.status, "failed");
  assert.equal(policyResult.requests, 1);
});

test("repeated cursors and GraphQL errors stop only after archiving the response", async () => {
  const repeated = harness([
    timelineResponse([{ id: "300", publishedAt: "2026-08-18T00:59:00.000Z" }], "same"),
    timelineResponse([{ id: "200", publishedAt: "2026-08-18T00:58:00.000Z" }], "same"),
  ]);
  const repeatedResult = await runTimelineCollection(options({
    bootstrapFrom: "2026-08-17T00:00:00.000Z",
  }), repeated.dependencies);
  assert.equal(repeatedResult.status, "partial");
  assert.equal(repeatedResult.stopReason, "repeated_cursor");
  assert.equal(repeated.events.filter((event) => event.startsWith("persist:")).length, 2);

  const graphql = harness([{
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ errors: [{ message: "bad query" }] })),
  }]);
  const graphqlResult = await runTimelineCollection(options(), graphql.dependencies);
  assert.equal(graphqlResult.status, "failed");
  assert.equal(graphqlResult.stopReason, "upstream_error");
  assert.ok(graphql.events.indexOf("persist:0:1") < graphql.events.indexOf("run:failed:upstream_error"));
});

test("timeline inspection rejects schema drift instead of treating it as exhaustion", () => {
  const inspected = inspectTimelineResponse(
    Buffer.from(JSON.stringify({
      data: {
        changed_shape: {
          instructions: [{ entries: [tweetEntry("999", "2026-08-18T00:59:00.000Z")] }],
        },
      },
    })),
    catalog,
    "list-1",
    "2026-08-18T01:00:00.000Z",
  );
  assert.equal(inspected.kind, "decode_error");
});

test("invalid JSON is persisted before decoding fails", async () => {
  const fake = harness([{ status: 200, headers: {}, body: Buffer.from("{") }]);
  const result = await runTimelineCollection(options(), fake.dependencies);
  assert.equal(result.stopReason, "decode_error");
  assert.ok(fake.events.indexOf("persist:0:1") < fake.events.indexOf("run:failed:decode_error"));
});

test("the production collector persists and verifies one mocked head page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-collector-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "archive.git");
  const repository = join(root, "writer");
  await git(root, "init", "--bare", remote);
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=archive");
  await git(repository, "config", "user.name", "kasumilog test");
  await git(repository, "config", "user.email", "kasumilog@example.invalid");
  await git(repository, "remote", "add", "origin", remote);
  const body = timelineResponse([
    { id: "300", publishedAt: "2026-08-18T00:59:00.000Z" },
  ], "older").body;

  const result = await collectListTimeline({
    repository,
    rawRoot: join(repository, "data", "raw"),
    remote: "origin",
    branch: "archive",
    listId: "list-1",
    listRevision: "a".repeat(64),
    catalogRevision: "b".repeat(64),
    requestCatalog: relayCatalog,
    catalog,
    relay: {
      profileName: "account2",
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
  });

  assert.equal(result.stopReason, "initial_seed");
  assert.equal(await git(repository, "rev-list", "--count", "HEAD"), "2");
  const recovered = await recoverArchiveState(join(repository, "data", "raw"), {
    listId: "list-1",
  });
  assert.deepEqual(recovered.latestCompleteRun?.coverageFrontier?.tweetIds, ["300"]);
  const fetchPath = (await git(repository, "ls-files"))
    .split("\n")
    .find((path) => path.includes("/fetches/"));
  assert.ok(fetchPath);
  const fetchManifest = JSON.parse(await readFile(
    join(repository, fetchPath),
    "utf8",
  ));
  assert.equal(fetchManifest.attempt, 1);
  assert.equal(fetchManifest.request.profileName, "account2");
});

test("the production collector rejects a stale archive branch before Relay access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-collector-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "archive.git");
  const repository = join(root, "writer");
  await git(root, "init", "--bare", remote);
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=archive");
  await git(repository, "config", "user.name", "kasumilog test");
  await git(repository, "config", "user.email", "kasumilog@example.invalid");
  await git(repository, "remote", "add", "origin", remote);
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  await git(repository, "push", "origin", "archive");
  await writeFile(join(repository, "README.md"), "local-only\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "local only");
  let relayRequests = 0;

  await assert.rejects(collectListTimeline({
    repository,
    rawRoot: join(repository, "data", "raw"),
    remote: "origin",
    branch: "archive",
    listId: "list-1",
    listRevision: "a".repeat(64),
    catalogRevision: "b".repeat(64),
    requestCatalog: relayCatalog,
    catalog,
    relay: {
      profileName: "account2",
      fetch: async () => {
        relayRequests += 1;
        return new Response("{}");
      },
    },
  }), /HEAD does not match/);
  assert.equal(relayRequests, 0);
});
