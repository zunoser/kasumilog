#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { collectFixturePage } from "./fixture-collector.ts";
import {
  collectListTimeline,
  type TimelineCollectionResult,
} from "./collector.ts";
import { catalog } from "./catalog.ts";
import {
  createRelayExecutionPlan,
  DEFAULT_RELAY_BASE_URL,
} from "./relay-client.ts";
import {
  buildListTimelineRequest,
  createRelayRequestCatalog,
} from "./relay.ts";
import { createCatalogRevision, createListRevision } from "./sync.ts";

const VERSION = "0.1.0";

const HELP = `kasumilog - build and verify the private raw archive

Usage:
  kasumilog collect-fixture --fixture FILE --repository DIR [options]
  kasumilog collect-timeline --request-catalog FILE --revision SHA --request-catalog-sha256 SHA256 --profile NAME --list-id ID --repository DIR [options]
  kasumilog plan-timeline --request-catalog FILE --revision SHA --profile NAME --list-id ID [options]
  kasumilog rebuild-search --raw-root DIR --database FILE [--json]
  kasumilog search --database FILE --query TEXT [--limit N] [--cursor CURSOR] [--json]
  kasumilog --help
  kasumilog --version

Options:
  --fixture FILE     Capture descriptor whose bodyFile is preserved byte-for-byte
  --repository DIR   Git worktree checked out on the archive branch
  --request-catalog FILE  Pinned requests.ndjson file
  --revision SHA     Commit SHA containing requests.ndjson
  --request-catalog-sha256 SHA256  Reviewed SHA-256 of requests.ndjson
  --profile NAME     Relay browser profile to pin for every request
  --list-id ID       Existing private Twitter list ID
  --remote NAME      Git remote to push (default: origin)
  --branch NAME      Archive branch (default: archive)
  --raw-root DIR     Root containing raw objects and fetch manifests
  --database FILE    Disposable local SQLite database
  --query TEXT       Literal local search terms
  --limit N          Search page size, 1-100 (default: 20)
  --cursor CURSOR    Cursor returned by the previous local search page
  --json             Print a stable JSON result
  --base-url URL     Relay HTTPS origin (default: https://tw.home.yutakobayashi.com)
  -h, --help         Show this help
  --version          Show the version

plan-timeline never calls Twitter or Relay and does not print query values.
collect-timeline performs a live read and prints no list ID, cursor, or tweet ID.
Without an existing frontier it seeds one head page; every run keeps finite safety caps.
`;

interface CollectFixtureArguments {
  readonly command: "collect-fixture";
  readonly fixture: string;
  readonly repository: string;
  readonly remote: string;
  readonly branch: string;
  readonly json: boolean;
}

interface PlanTimelineArguments {
  readonly command: "plan-timeline";
  readonly requestCatalog: string;
  readonly revision: string;
  readonly listId: string;
  readonly profileName: string;
  readonly baseUrl: string;
  readonly json: boolean;
}

export interface CollectTimelineArguments {
  readonly command: "collect-timeline";
  readonly requestCatalog: string;
  readonly revision: string;
  readonly requestCatalogSha256: string;
  readonly listId: string;
  readonly profileName: string;
  readonly repository: string;
  readonly remote: string;
  readonly branch: string;
  readonly baseUrl: string;
  readonly json: boolean;
}

interface RebuildSearchArguments {
  readonly command: "rebuild-search";
  readonly rawRoot: string;
  readonly database: string;
  readonly json: boolean;
}

interface SearchArguments {
  readonly command: "search";
  readonly database: string;
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly json: boolean;
}

type Arguments =
  | CollectFixtureArguments
  | CollectTimelineArguments
  | PlanTimelineArguments
  | RebuildSearchArguments
  | SearchArguments;

class UsageError extends Error {}

export interface SafeCollectionOutput {
  readonly runId: string;
  readonly status: TimelineCollectionResult["status"];
  readonly stopReason: TimelineCollectionResult["stopReason"];
  readonly requests: number;
  readonly timelinePages: number;
  readonly items: number;
  readonly coverageAdvanced: boolean;
}

function option(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new UsageError(`${name} requires a value`);
  return value;
}

export function parseArguments(args: readonly string[]): Arguments | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version")) return "version";
  if (
    args[0] !== "collect-fixture" &&
    args[0] !== "collect-timeline" &&
    args[0] !== "plan-timeline" &&
    args[0] !== "rebuild-search" &&
    args[0] !== "search"
  ) {
    throw new UsageError(
      "Expected collect-fixture, collect-timeline, plan-timeline, rebuild-search, or search",
    );
  }
  if (args[0] === "rebuild-search") {
    let rawRoot: string | undefined;
    let database: string | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      switch (args[index]) {
        case "--raw-root": rawRoot = option(args, index++, "--raw-root"); break;
        case "--database": database = option(args, index++, "--database"); break;
        case "--json": json = true; break;
        default: throw new UsageError(`Unknown option: ${args[index]}`);
      }
    }
    if (!rawRoot) throw new UsageError("--raw-root is required");
    if (!database) throw new UsageError("--database is required");
    return { command: "rebuild-search", rawRoot, database, json };
  }
  if (args[0] === "search") {
    let database: string | undefined;
    let query: string | undefined;
    let limit: number | undefined;
    let cursor: string | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      switch (args[index]) {
        case "--database": database = option(args, index++, "--database"); break;
        case "--query": query = option(args, index++, "--query"); break;
        case "--limit": limit = Number(option(args, index++, "--limit")); break;
        case "--cursor": cursor = option(args, index++, "--cursor"); break;
        case "--json": json = true; break;
        default: throw new UsageError(`Unknown option: ${args[index]}`);
      }
    }
    if (!database) throw new UsageError("--database is required");
    if (!query) throw new UsageError("--query is required");
    return { command: "search", database, query, limit, cursor, json };
  }
  if (args[0] === "plan-timeline") {
    let requestCatalog: string | undefined;
    let revision: string | undefined;
    let listId: string | undefined;
    let profileName: string | undefined;
    let baseUrl = DEFAULT_RELAY_BASE_URL;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      switch (args[index]) {
        case "--request-catalog":
          requestCatalog = option(args, index++, "--request-catalog");
          break;
        case "--revision": revision = option(args, index++, "--revision"); break;
        case "--list-id": listId = option(args, index++, "--list-id"); break;
        case "--profile": profileName = option(args, index++, "--profile"); break;
        case "--base-url": baseUrl = option(args, index++, "--base-url"); break;
        case "--json": json = true; break;
        default: throw new UsageError(`Unknown option: ${args[index]}`);
      }
    }
    if (!requestCatalog) throw new UsageError("--request-catalog is required");
    if (!revision) throw new UsageError("--revision is required");
    if (!listId) throw new UsageError("--list-id is required");
    if (!profileName) throw new UsageError("--profile is required");
    return {
      command: "plan-timeline",
      requestCatalog,
      revision,
      listId,
      profileName,
      baseUrl,
      json,
    };
  }
  if (args[0] === "collect-timeline") {
    let requestCatalog: string | undefined;
    let revision: string | undefined;
    let requestCatalogSha256: string | undefined;
    let listId: string | undefined;
    let profileName: string | undefined;
    let repository: string | undefined;
    let remote = "origin";
    let branch = "archive";
    let baseUrl = DEFAULT_RELAY_BASE_URL;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      switch (args[index]) {
        case "--request-catalog":
          requestCatalog = option(args, index++, "--request-catalog");
          break;
        case "--revision": revision = option(args, index++, "--revision"); break;
        case "--request-catalog-sha256":
          requestCatalogSha256 = option(args, index++, "--request-catalog-sha256");
          break;
        case "--list-id": listId = option(args, index++, "--list-id"); break;
        case "--profile": profileName = option(args, index++, "--profile"); break;
        case "--repository": repository = option(args, index++, "--repository"); break;
        case "--remote": remote = option(args, index++, "--remote"); break;
        case "--branch": branch = option(args, index++, "--branch"); break;
        case "--base-url": baseUrl = option(args, index++, "--base-url"); break;
        case "--json": json = true; break;
        default: throw new UsageError(`Unknown option: ${args[index]}`);
      }
    }
    if (!requestCatalog) throw new UsageError("--request-catalog is required");
    if (!revision) throw new UsageError("--revision is required");
    if (!requestCatalogSha256) {
      throw new UsageError("--request-catalog-sha256 is required");
    }
    if (!listId) throw new UsageError("--list-id is required");
    if (!profileName) throw new UsageError("--profile is required");
    if (!repository) throw new UsageError("--repository is required");
    return {
      command: "collect-timeline",
      requestCatalog,
      revision,
      requestCatalogSha256,
      listId,
      profileName,
      repository,
      remote,
      branch,
      baseUrl,
      json,
    };
  }
  let fixture: string | undefined;
  let repository: string | undefined;
  let remote = "origin";
  let branch = "archive";
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    switch (args[index]) {
      case "--fixture": fixture = option(args, index++, "--fixture"); break;
      case "--repository": repository = option(args, index++, "--repository"); break;
      case "--remote": remote = option(args, index++, "--remote"); break;
      case "--branch": branch = option(args, index++, "--branch"); break;
      case "--json": json = true; break;
      default: throw new UsageError(`Unknown option: ${args[index]}`);
    }
  }
  if (!fixture) throw new UsageError("--fixture is required");
  if (!repository) throw new UsageError("--repository is required");
  return { command: "collect-fixture", fixture, repository, remote, branch, json };
}

export async function executeCollectTimeline(
  args: CollectTimelineArguments,
  collect: typeof collectListTimeline = collectListTimeline,
): Promise<SafeCollectionOutput> {
  const content = await readFile(resolve(args.requestCatalog), "utf8");
  if (!/^[0-9a-f]{64}$/.test(args.requestCatalogSha256)) {
    throw new Error("request catalog SHA-256 must be 64 lowercase hex characters");
  }
  const actualSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (actualSha256 !== args.requestCatalogSha256) {
    throw new Error("request catalog SHA-256 does not match the reviewed lock");
  }
  const requestCatalog = createRelayRequestCatalog(content, args.revision);
  const request = buildListTimelineRequest(requestCatalog, args.listId);
  createRelayExecutionPlan(request, args.baseUrl, args.profileName);
  const repository = resolve(args.repository);
  const result = await collect({
    repository,
    rawRoot: join(repository, "data", "raw"),
    remote: args.remote,
    branch: args.branch,
    listId: args.listId,
    listRevision: createListRevision(catalog),
    catalogRevision: createCatalogRevision(catalog),
    requestCatalog,
    catalog,
    relay: { baseUrl: args.baseUrl, profileName: args.profileName },
  });
  return {
    runId: result.runId,
    status: result.status,
    stopReason: result.stopReason,
    requests: result.requests,
    timelinePages: result.timelinePages,
    items: result.items,
    coverageAdvanced: result.coverageFrontier !== undefined,
  };
}

export function formatCollectionOutput(
  output: SafeCollectionOutput,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(output)}\n`;
  return [
    `Archive collection ${output.status}: ${output.stopReason}`,
    `requests: ${output.requests}`,
    `pages:    ${output.timelinePages}`,
    `items:    ${output.items}`,
    `coverage: ${output.coverageAdvanced ? "advanced" : "unchanged"}`,
  ].join("\n") + "\n";
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    console.error("Run kasumilog --help for usage.");
    process.exitCode = 2;
    return;
  }
  if (args === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args === "version") {
    console.log(VERSION);
    return;
  }
  try {
    if (args.command === "rebuild-search") {
      const { rebuildSearchIndexFromRaw } = await import("./search-index.ts");
      const result = await rebuildSearchIndexFromRaw({
        rawRoot: resolve(args.rawRoot),
        databasePath: resolve(args.database),
        catalog,
      });
      if (args.json) console.log(JSON.stringify(result));
      else {
        console.log(
          `Indexed ${result.posts} posts from ${result.fetches} raw fetches ` +
          `(${result.skippedFetches} non-success responses skipped)`,
        );
      }
      return;
    }
    if (args.command === "search") {
      const { searchIndex } = await import("./search-index.ts");
      const result = searchIndex({
        databasePath: resolve(args.database),
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      if (args.json) console.log(JSON.stringify(result));
      else {
        for (const item of result.items) {
          console.log(`${item.publishedAt} ${item.tweetId} ${item.text.replaceAll("\n", " ")}`);
        }
        if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
      }
      return;
    }
    if (args.command === "plan-timeline") {
      const content = await readFile(resolve(args.requestCatalog), "utf8");
      const catalog = createRelayRequestCatalog(content, args.revision);
      const request = buildListTimelineRequest(catalog, args.listId);
      const plan = createRelayExecutionPlan(request, args.baseUrl, args.profileName);
      if (args.json) console.log(JSON.stringify(plan));
      else {
        console.log(`Relay plan: ${plan.method} ${plan.origin}${plan.path}`);
        console.log(`operation: ${plan.operation}`);
        console.log(`profile:   ${plan.profileName}`);
        console.log(`catalog:   ${plan.requestCatalogRevision}`);
        console.log(`params:    ${plan.parameterNames.join(", ")}`);
      }
      return;
    }
    if (args.command === "collect-timeline") {
      const output = await executeCollectTimeline(args);
      process.stdout.write(formatCollectionOutput(output, args.json));
      if (output.status === "failed") process.exitCode = 1;
      return;
    }
    const repository = resolve(args.repository);
    const result = await collectFixturePage({
      fixturePath: resolve(args.fixture),
      repository,
      rawRoot: join(repository, "data", "raw"),
      remote: args.remote,
      branch: args.branch,
    });
    if (args.json) console.log(JSON.stringify(result));
    else {
      console.log(`Archived fixture ${result.fetchId}`);
      console.log(`page commit: ${result.pageCommit}`);
      console.log(`run commit:  ${result.runCommit}`);
      console.log(`idempotent:  ${result.idempotent}`);
    }
  } catch (error) {
    console.error(args.command === "collect-timeline"
      ? "error: timeline collection failed"
      : `error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
