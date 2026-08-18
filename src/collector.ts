import { createHash, randomUUID } from "node:crypto";

import {
  commitAndPushArchivePaths,
  preflightArchiveTarget,
  verifyRemoteRawPage,
  verifyRemoteRawRun,
  type ArchiveGitTarget,
} from "./archive-git.ts";
import { extractArchiveBatch, type ArchivedPost } from "./archive.ts";
import type { Catalog } from "./model.ts";
import {
  recoverArchiveState,
  storeRawCapture,
  storeRawRun,
  type RawCaptureResponse,
  type RawCoverageFrontier,
  type RawRunInput,
  type RawRunPage,
  type RawRunStatus,
  type RawRunStopReason,
} from "./raw.ts";
import {
  buildListTimelineRequest,
  LIST_RELAY_OPERATIONS,
  type RelayRequestCatalog,
  type RelayRequestSpec,
} from "./relay.ts";
import {
  executeListTimelineRequest,
  RelayClientPolicyError,
  type RelayClientOptions,
} from "./relay-client.ts";

export interface CollectionLimits {
  readonly maxTimelinePages: number;
  readonly maxRequests: number;
  readonly maxItems: number;
  readonly maxRunMs: number;
  readonly maxAttemptsPerPage: number;
  readonly minimumIntervalMs: number;
  readonly pacingJitterMs: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
}

export const DEFAULT_COLLECTION_LIMITS: CollectionLimits = {
  maxTimelinePages: 8,
  maxRequests: 12,
  maxItems: 600,
  maxRunMs: 10 * 60_000,
  maxAttemptsPerPage: 3,
  minimumIntervalMs: 30_000,
  pacingJitterMs: 15_000,
  retryBaseMs: 60_000,
  retryCapMs: 15 * 60_000,
};

export interface TimelinePageInspection {
  readonly kind: "page";
  readonly posts: readonly ArchivedPost[];
  readonly chronologicalFloor?: string;
  readonly nextCursor?: string;
}

export interface TimelinePageInspectionError {
  readonly kind: "decode_error" | "graphql_error";
  readonly message: string;
}

export type TimelineInspection = TimelinePageInspection | TimelinePageInspectionError;

export interface PersistCaptureInput {
  readonly runId: string;
  readonly page: number;
  readonly attempt: number;
  readonly cursorIn?: string;
  readonly request: RelayRequestSpec;
  readonly response: RawCaptureResponse;
  readonly requestedAt: string;
  readonly receivedAt: string;
}

export interface TimelineCollectorDependencies {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
  readonly execute: (request: RelayRequestSpec) => Promise<RawCaptureResponse>;
  readonly persistCapture: (input: PersistCaptureInput) => Promise<RawRunPage>;
  readonly persistRun: (input: RawRunInput) => Promise<void>;
}

export interface RunTimelineCollectionOptions {
  readonly runId: string;
  readonly listId: string;
  readonly listRevision: string;
  readonly catalogRevision: string;
  readonly requestCatalog: RelayRequestCatalog;
  readonly catalog: Catalog;
  readonly bootstrapFrom?: string;
  readonly previousFrontier?: RawCoverageFrontier;
  readonly notBefore?: string;
  readonly limits?: Partial<CollectionLimits>;
}

export interface TimelineCollectionResult {
  readonly runId: string;
  readonly status: RawRunStatus;
  readonly stopReason: RawRunStopReason;
  readonly requests: number;
  readonly timelinePages: number;
  readonly items: number;
  readonly coverageFrontier?: RawCoverageFrontier;
}

export interface CollectListTimelineOptions extends ArchiveGitTarget {
  readonly listId: string;
  readonly listRevision: string;
  readonly catalogRevision: string;
  readonly requestCatalog: RelayRequestCatalog;
  readonly catalog: Catalog;
  readonly bootstrapFrom?: string;
  readonly limits?: Partial<CollectionLimits>;
  readonly relay: RelayClientOptions;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export function inspectTimelineResponse(
  body: Uint8Array,
  catalog: Catalog,
  listId: string,
  collectedAt: string,
): TimelineInspection {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { kind: "decode_error", message: "Timeline response is not valid UTF-8 JSON" };
  }
  const root = asObject(payload);
  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    return { kind: "graphql_error", message: "Timeline response contains GraphQL errors" };
  }

  const data = asObject(root?.data);
  const list = asObject(data?.list);
  const tweetsTimeline = asObject(list?.tweets_timeline);
  const timeline = asObject(tweetsTimeline?.timeline);
  const instructions = timeline?.instructions;
  if (!Array.isArray(instructions)) {
    return {
      kind: "decode_error",
      message: "Timeline response has no list timeline instructions",
    };
  }

  const posts = new Map<string, ArchivedPost>();
  const instructionBatch = extractArchiveBatch(
    { instructions },
    catalog,
    listId,
    collectedAt,
  );
  for (const instruction of instructions) {
    const object = asObject(instruction);
    if (!Array.isArray(object?.entries)) continue;
    for (const entry of object.entries) {
      const entryObject = asObject(entry);
      if (typeof entryObject?.entryId !== "string" || !entryObject.entryId.startsWith("tweet-")) {
        continue;
      }
      for (const post of extractArchiveBatch(entry, catalog, listId, collectedAt).posts) {
        posts.set(post.tweetId, post);
      }
    }
  }
  const orderedPosts = [...posts.values()];
  return {
    kind: "page",
    posts: orderedPosts,
    ...(orderedPosts.at(-1)
      ? { chronologicalFloor: orderedPosts.at(-1)?.publishedAt }
      : {}),
    ...(instructionBatch.nextCursor ? { nextCursor: instructionBatch.nextCursor } : {}),
  };
}

function collectionLimits(overrides: Partial<CollectionLimits> | undefined): CollectionLimits {
  const limits = { ...DEFAULT_COLLECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Collection limit must be a positive integer: ${name}`);
    }
  }
  if (limits.maxAttemptsPerPage > limits.maxRequests) {
    throw new Error("maxAttemptsPerPage must not exceed maxRequests");
  }
  return limits;
}

function parseInstant(label: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid ${label}: ${value}`);
  return timestamp;
}

function header(response: RawCaptureResponse, name: string): string | undefined {
  const value = Object.entries(response.headers)
    .find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function retryAfter(response: RawCaptureResponse, receivedAt: number): number | undefined {
  const value = header(response, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return receivedAt + seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

function rateLimitReset(response: RawCaptureResponse): number | undefined {
  if (header(response, "x-rate-limit-remaining") !== "0") return undefined;
  const seconds = Number(header(response, "x-rate-limit-reset"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504;
}

function boundedRandom(random: () => number): number {
  return Math.max(0, Math.min(1, random()));
}

function headFrontier(posts: readonly ArchivedPost[]): RawCoverageFrontier | undefined {
  const newest = posts.reduce<string | undefined>(
    (current, post) => !current || post.publishedAt > current ? post.publishedAt : current,
    undefined,
  );
  if (!newest) return undefined;
  return {
    publishedAt: newest,
    tweetIds: posts
      .filter(({ publishedAt }) => publishedAt === newest)
      .map(({ tweetId }) => tweetId)
      .sort(),
  };
}

export async function runTimelineCollection(
  options: RunTimelineCollectionOptions,
  dependencies: TimelineCollectorDependencies,
): Promise<TimelineCollectionResult> {
  const limits = collectionLimits(options.limits);
  const startedAtMs = dependencies.now();
  const deadline = startedAtMs + limits.maxRunMs;
  const bootstrapFrom = parseInstant("bootstrapFrom", options.bootstrapFrom);
  const recoveredNotBefore = parseInstant("notBefore", options.notBefore);
  if (bootstrapFrom !== undefined && bootstrapFrom > startedAtMs) {
    throw new Error("bootstrapFrom must not be in the future");
  }
  if (bootstrapFrom !== undefined && options.previousFrontier) {
    throw new Error("bootstrapFrom cannot be combined with previousFrontier");
  }

  const pages: RawRunPage[] = [];
  const seenItems = new Set<string>();
  const seenCursors = new Set<string>();
  const previousIds = new Set(options.previousFrontier?.tweetIds ?? []);
  let sawPreviousId = false;
  let sawOlderThanPrevious = false;
  let requests = 0;
  let cursor: string | undefined;
  let page = 0;
  let attempts = 0;
  let nextAllowedAt = recoveredNotBefore === undefined
    ? startedAtMs
    : recoveredNotBefore + boundedRandom(dependencies.random) * limits.pacingJitterMs;
  let newFrontier: RawCoverageFrontier | undefined;

  const finish = async (
    status: RawRunStatus,
    stopReason: RawRunStopReason,
    coverageFrontier?: RawCoverageFrontier,
  ): Promise<TimelineCollectionResult> => {
    const finishedAtMs = dependencies.now();
    const run: RawRunInput = {
      runId: options.runId,
      source: { kind: "list_timeline", listId: options.listId },
      status,
      stopReason,
      pages,
      ...(coverageFrontier ? { coverageFrontier } : {}),
      catalogRevision: options.catalogRevision,
      listRevision: options.listRevision,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      ...(pages.at(-1) ? { lastVerifiedPageCommit: pages.at(-1)?.verifiedCommit } : {}),
    };
    await dependencies.persistRun(run);
    return {
      runId: options.runId,
      status,
      stopReason,
      requests,
      timelinePages: pages.length,
      items: seenItems.size,
      ...(coverageFrontier ? { coverageFrontier } : {}),
    };
  };

  const fail = (reason: RawRunStopReason) =>
    finish(pages.length > 0 ? "partial" : "failed", reason);

  while (true) {
    if (requests >= limits.maxRequests) return fail("request_limit");
    if (page >= limits.maxTimelinePages) return fail("page_limit");
    const now = dependencies.now();
    if (now >= deadline || nextAllowedAt > deadline) return fail("wall_clock_limit");
    if (nextAllowedAt > now) await dependencies.sleep(nextAllowedAt - now);
    if (dependencies.now() >= deadline) return fail("wall_clock_limit");

    const request = buildListTimelineRequest(options.requestCatalog, options.listId, cursor);
    const requestedAtMs = dependencies.now();
    requests += 1;
    attempts += 1;
    let response: RawCaptureResponse;
    try {
      response = await dependencies.execute(request);
    } catch (error) {
      const failedAt = dependencies.now();
      if (error instanceof RelayClientPolicyError) return fail("upstream_error");
      if (attempts >= limits.maxAttemptsPerPage) {
        const name = (error as Error).name;
        return fail(name === "TimeoutError" || name === "AbortError" ? "timeout" : "upstream_error");
      }
      const pacing = limits.minimumIntervalMs +
        boundedRandom(dependencies.random) * limits.pacingJitterMs;
      const retryCap = Math.min(
        limits.retryCapMs,
        limits.retryBaseMs * 2 ** (attempts - 1),
      );
      const backoff = boundedRandom(dependencies.random) * retryCap;
      nextAllowedAt = failedAt + Math.max(pacing, backoff);
      continue;
    }

    const receivedAtMs = dependencies.now();
    const verified = await dependencies.persistCapture({
      runId: options.runId,
      page,
      attempt: attempts,
      ...(cursor ? { cursorIn: cursor } : {}),
      request,
      response,
      requestedAt: new Date(requestedAtMs).toISOString(),
      receivedAt: new Date(receivedAtMs).toISOString(),
    });

    const pacing = limits.minimumIntervalMs +
      boundedRandom(dependencies.random) * limits.pacingJitterMs;
    nextAllowedAt = Math.max(
      receivedAtMs + pacing,
      rateLimitReset(response) ?? 0,
    );

    if (retryableStatus(response.status)) {
      if (attempts >= limits.maxAttemptsPerPage) {
        return fail(response.status === 429 ? "rate_limited" : "upstream_error");
      }
      const retryCap = Math.min(
        limits.retryCapMs,
        limits.retryBaseMs * 2 ** (attempts - 1),
      );
      nextAllowedAt = Math.max(
        nextAllowedAt,
        receivedAtMs + boundedRandom(dependencies.random) * retryCap,
        retryAfter(response, receivedAtMs) ?? 0,
        rateLimitReset(response) ?? 0,
      );
      continue;
    }
    if (response.status < 200 || response.status >= 300) return fail("upstream_error");
    let inspection: TimelineInspection;
    try {
      inspection = inspectTimelineResponse(
        response.body,
        options.catalog,
        options.listId,
        new Date(receivedAtMs).toISOString(),
      );
    } catch (error) {
      inspection = {
        kind: "decode_error",
        message: error instanceof Error ? error.message : "Timeline inspection failed",
      };
    }
    if (inspection?.kind === "graphql_error") return fail("upstream_error");
    if (inspection.kind === "decode_error") return fail("decode_error");

    if (verified.page !== page) {
      throw new Error(`Persisted page does not match logical page ${page}`);
    }
    pages.push(verified);
    attempts = 0;
    for (const post of inspection.posts) {
      seenItems.add(post.tweetId);
      if (previousIds.has(post.tweetId)) sawPreviousId = true;
    }
    if (
      options.previousFrontier &&
      inspection.chronologicalFloor &&
      inspection.chronologicalFloor < options.previousFrontier.publishedAt
    ) {
      sawOlderThanPrevious = true;
    }
    newFrontier ??= headFrontier(inspection.posts);

    if (!options.previousFrontier && bootstrapFrom === undefined && newFrontier) {
      return finish("complete", "initial_seed", newFrontier);
    }
    if (
      options.previousFrontier &&
      (sawPreviousId || sawOlderThanPrevious)
    ) {
      return finish("complete", "frontier_reached", newFrontier);
    }
    if (
      bootstrapFrom !== undefined &&
      inspection.chronologicalFloor !== undefined &&
      Date.parse(inspection.chronologicalFloor) <= bootstrapFrom
    ) {
      return finish("complete", "bootstrap_boundary_reached", newFrontier);
    }
    if (!inspection.nextCursor) {
      return newFrontier
        ? finish("complete", "exhausted", newFrontier)
        : fail("exhausted");
    }
    if (!options.previousFrontier && bootstrapFrom === undefined) {
      return fail("page_limit");
    }
    if (seenItems.size >= limits.maxItems) return fail("item_limit");
    if (page + 1 >= limits.maxTimelinePages) return fail("page_limit");
    if (inspection.nextCursor === cursor) return fail("repeated_cursor");
    if (seenCursors.has(inspection.nextCursor)) return fail("cursor_cycle");
    seenCursors.add(inspection.nextCursor);
    cursor = inspection.nextCursor;
    page += 1;
  }
}

function variablesSha256(request: RelayRequestSpec): string {
  const variables = request.params?.variables;
  if (typeof variables !== "string") throw new Error("Timeline request has no variables");
  return createHash("sha256").update(variables, "utf8").digest("hex");
}

export async function collectListTimeline(
  options: CollectListTimelineOptions,
): Promise<TimelineCollectionResult> {
  const rawRoot = options.rawRoot;
  await preflightArchiveTarget(options);
  const recovered = await recoverArchiveState(rawRoot, { listId: options.listId });
  const runId = `timeline-${randomUUID()}`;
  const target: ArchiveGitTarget = options;
  const previousFrontier = recovered.latestCompleteRun?.coverageFrontier;
  return runTimelineCollection({
    runId,
    listId: options.listId,
    listRevision: options.listRevision,
    catalogRevision: options.catalogRevision,
    requestCatalog: options.requestCatalog,
    catalog: options.catalog,
    ...(!previousFrontier && options.bootstrapFrom
      ? { bootstrapFrom: options.bootstrapFrom }
      : {}),
    ...(previousFrontier
      ? { previousFrontier }
      : {}),
    ...(recovered.notBefore ? { notBefore: recovered.notBefore } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  }, {
    now: Date.now,
    sleep: (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds)),
    random: Math.random,
    execute: (request) => executeListTimelineRequest(request, options.relay),
    persistCapture: async (input) => {
      const fetchId = `timeline-${randomUUID()}`;
      const stored = await storeRawCapture(rawRoot, {
        fetchId,
        runId: input.runId,
        page: input.page,
        attempt: input.attempt,
        listId: options.listId,
        catalogRevision: options.catalogRevision,
        listRevision: options.listRevision,
        requestedAt: input.requestedAt,
        receivedAt: input.receivedAt,
        request: {
          operation: LIST_RELAY_OPERATIONS.timeline,
          profileName: options.relay.profileName,
          requestCatalog: input.request.requestCatalog,
          requestTemplateSha256: input.request.requestTemplateSha256,
          variablesSha256: variablesSha256(input.request),
          ...(input.cursorIn ? { cursorIn: input.cursorIn } : {}),
        },
        response: {
          ...input.response,
        },
      });
      const pushed = await commitAndPushArchivePaths(
        target,
        [stored.objectPath, stored.manifestPath],
        `archive page ${input.runId}/${input.page} attempt ${input.attempt}`,
      );
      const remote = await verifyRemoteRawPage(target, pushed.commit, stored.manifestPath);
      if (
        remote.fetchId !== fetchId ||
        remote.runId !== input.runId ||
        remote.page !== input.page
      ) {
        throw new Error("Remote capture does not match the collection attempt");
      }
      return { page: input.page, fetchId, verifiedCommit: pushed.commit };
    },
    persistRun: async (input) => {
      const stored = await storeRawRun(rawRoot, input);
      const pushed = await commitAndPushArchivePaths(
        target,
        [stored.manifestPath],
        `archive run ${input.runId}`,
      );
      await verifyRemoteRawRun(target, pushed.commit, stored.manifestPath);
    },
  });
}
