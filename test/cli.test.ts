import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  executeCollectTimeline,
  formatCollectionOutput,
  parseArguments,
  type CollectTimelineArguments,
} from "../src/cli.ts";

function requestCatalog(): string {
  return [
    ["POST", "CreateList", { variables: {} }],
    ["GET", "ListMembers", JSON.stringify({ listId: "old", count: 20 })],
    ["POST", "ListAddMember", { variables: {} }],
    ["POST", "ListRemoveMember", { variables: {} }],
    ["GET", "ListLatestTweetsTimeline", JSON.stringify({
      listId: "example",
      count: 40,
      cursor: "old",
    })],
  ].map(([method, operation, variables]) => JSON.stringify({
    method,
    path: `/graphql/query-lock/${operation}`,
    headers: { "content-type": "application/json" },
    ...(method === "GET"
      ? { params: { variables, features: "{}" } }
      : { data: variables }),
  })).concat(JSON.stringify({
    method: "GET",
    path: "/1.1/unrelated-without-headers.json",
  })).join("\n");
}

function requestCatalogSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

test("collect-timeline parses a deliberately small live-read interface", () => {
  const parsed = parseArguments([
    "collect-timeline",
    "--request-catalog", "requests.ndjson",
    "--revision", "0".repeat(40),
    "--request-catalog-sha256", "f".repeat(64),
    "--profile", "account2",
    "--list-id", "list-secret",
    "--repository", "archive-worktree",
    "--json",
  ]);
  assert.notEqual(typeof parsed, "string");
  assert.deepEqual(parsed, {
    command: "collect-timeline",
    requestCatalog: "requests.ndjson",
    revision: "0".repeat(40),
    requestCatalogSha256: "f".repeat(64),
    profileName: "account2",
    listId: "list-secret",
    repository: "archive-worktree",
    remote: "origin",
    branch: "archive",
    baseUrl: "https://tw.home.yutakobayashi.com",
    json: true,
  });
  assert.throws(
    () => parseArguments(["collect-timeline", "--cursor", "must-not-be-accepted"]),
    /Unknown option: --cursor/,
  );
  assert.throws(
    () => parseArguments([
      "collect-timeline",
      "--request-catalog", "requests.ndjson",
      "--revision", "0".repeat(40),
      "--request-catalog-sha256", "f".repeat(64),
      "--list-id", "list-secret",
      "--repository", "archive-worktree",
    ]),
    /--profile is required/,
  );
});

test("collect-timeline computes revisions and calls one injected collector", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "requests.ndjson");
  const content = `${requestCatalog()}\n`;
  await writeFile(catalogPath, content);
  let received: Parameters<typeof import("../src/collector.ts").collectListTimeline>[0] | undefined;
  const args: CollectTimelineArguments = {
    command: "collect-timeline",
    requestCatalog: catalogPath,
    revision: "0".repeat(40),
    requestCatalogSha256: requestCatalogSha256(content),
    profileName: "account2",
    listId: "list-secret",
    repository: join(directory, "archive"),
    remote: "origin",
    branch: "archive",
    baseUrl: "https://tw.home.yutakobayashi.com",
    json: true,
  };

  const output = await executeCollectTimeline(args, async (options) => {
    received = options;
    return {
      runId: "run-safe",
      status: "complete",
      stopReason: "initial_seed",
      requests: 1,
      timelinePages: 1,
      items: 2,
      coverageFrontier: {
        publishedAt: "2026-08-18T00:00:00.000Z",
        tweetIds: ["tweet-secret"],
      },
    };
  });

  assert.equal(received?.repository, resolve(args.repository));
  assert.equal(received?.rawRoot, join(resolve(args.repository), "data", "raw"));
  assert.equal(received?.listId, "list-secret");
  assert.match(received?.catalogRevision ?? "", /^[0-9a-f]{64}$/);
  assert.match(received?.listRevision ?? "", /^[0-9a-f]{64}$/);
  assert.equal(received?.relay?.baseUrl, "https://tw.home.yutakobayashi.com");
  assert.equal(received?.relay?.profileName, "account2");
  const json = formatCollectionOutput(output, true);
  const human = formatCollectionOutput(output, false);
  assert.doesNotMatch(json, /list-secret|tweet-secret|cursor/);
  assert.doesNotMatch(human, /list-secret|tweet-secret|cursor/);
  assert.deepEqual(JSON.parse(json), {
    runId: "run-safe",
    status: "complete",
    stopReason: "initial_seed",
    requests: 1,
    timelinePages: 1,
    items: 2,
    coverageAdvanced: true,
  });
});

test("an invalid request catalog revision fails before the collector", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "requests.ndjson");
  const content = `${requestCatalog()}\n`;
  await writeFile(catalogPath, content);
  let calls = 0;
  await assert.rejects(executeCollectTimeline({
    command: "collect-timeline",
    requestCatalog: catalogPath,
    revision: "main",
    requestCatalogSha256: requestCatalogSha256(content),
    profileName: "account2",
    listId: "list-secret",
    repository: join(directory, "archive"),
    remote: "origin",
    branch: "archive",
    baseUrl: "https://tw.home.yutakobayashi.com",
    json: true,
  }, async () => {
    calls += 1;
    throw new Error("must not run");
  }), /commit SHA/);
  assert.equal(calls, 0);
});

test("a mismatched request catalog hash fails before the collector", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "requests.ndjson");
  await writeFile(catalogPath, `${requestCatalog()}\n`);
  let calls = 0;
  await assert.rejects(executeCollectTimeline({
    command: "collect-timeline",
    requestCatalog: catalogPath,
    revision: "0".repeat(40),
    requestCatalogSha256: "f".repeat(64),
    profileName: "account2",
    listId: "list-secret",
    repository: join(directory, "archive"),
    remote: "origin",
    branch: "archive",
    baseUrl: "https://tw.home.yutakobayashi.com",
    json: true,
  }, async () => {
    calls += 1;
    throw new Error("must not run");
  }), /does not match the reviewed lock/);
  assert.equal(calls, 0);
});
