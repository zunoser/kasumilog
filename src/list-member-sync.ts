import type { Catalog } from "./model.ts";
import {
  buildListMembersRequest,
  buildRelayRequest,
  extractListMembers,
  LIST_RELAY_OPERATIONS,
  type RelayRequestCatalog,
  type RelayRequestSpec,
} from "./relay.ts";

const DEFAULT_BASE_URL = "https://tw.home.yutakobayashi.com";
const TARGET_LIST_ID = "2089423174601670906";
const MEMBER_PAGE_SIZE = 20;

export interface SyncListMembersDependencies {
  readonly fetch: typeof fetch;
  readonly nowMs: () => number;
  readonly random: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onProgress?: (message: string) => void;
}

export interface SyncListMembersOptions {
  readonly catalog: Catalog;
  readonly requestCatalog: RelayRequestCatalog;
  readonly listId: string;
  readonly profileName: "account2";
  readonly baseUrl?: string;
  readonly minIntervalMs?: number;
  readonly jitterMs?: number;
  readonly maxMemberPages?: number;
}

export interface SyncListMembersResult {
  readonly before: number;
  readonly added: number;
  readonly removed: number;
  readonly after: number;
  readonly verified: boolean;
}

interface RelayJsonResponse {
  readonly response: Response;
  readonly payload: unknown;
}

function visitObjects(value: unknown, visitor: (object: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visitor);
    return;
  }
  const object = value as Record<string, unknown>;
  visitor(object);
  for (const child of Object.values(object)) visitObjects(child, visitor);
}

function bottomCursor(payload: unknown): string | undefined {
  let cursor: string | undefined;
  visitObjects(payload, (object) => {
    if (
      cursor === undefined &&
      object.cursorType === "Bottom" &&
      typeof object.value === "string"
    ) {
      cursor = object.value;
    }
  });
  return cursor;
}

function graphqlErrors(payload: unknown): readonly unknown[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const errors = (payload as Record<string, unknown>).errors;
  return Array.isArray(errors) ? errors : [];
}

function isKnownListBannerDecodeError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return error.code === 214 &&
    error.message === "BadRequest: com.twitter.strato.serialization.DecodeException" &&
    Array.isArray(error.path) &&
    error.path.length === 3 &&
    error.path[0] === "list" &&
    error.path[1] === "default_banner_media_results" &&
    error.path[2] === "result";
}

function relayUrl(request: RelayRequestSpec, baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Relay base URL must be an HTTPS origin");
  }
  const url = new URL(`/i/api${request.path}`, base);
  if (request.method === "GET") {
    for (const [name, value] of Object.entries(request.params ?? {})) {
      if (typeof value !== "string") throw new Error(`Relay parameter is not a string: ${name}`);
      url.searchParams.set(name, value);
    }
  }
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Relay response is not JSON");
  }
}

export async function syncListMembers(
  options: SyncListMembersOptions,
  dependencies: Partial<SyncListMembersDependencies> = {},
): Promise<SyncListMembersResult> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const nowMs = dependencies.nowMs ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  ));
  const onProgress = dependencies.onProgress ?? (() => {});
  const minIntervalMs = options.minIntervalMs ?? 15_000;
  const jitterMs = options.jitterMs ?? 10_000;
  const maxMemberPages = options.maxMemberPages ?? 10;
  if (
    options.profileName !== "account2" ||
    options.listId !== TARGET_LIST_ID ||
    (options.baseUrl ?? DEFAULT_BASE_URL) !== DEFAULT_BASE_URL
  ) {
    throw new Error("List member sync is locked to account2 and the kasumilog list");
  }
  if (minIntervalMs < 15_000 || jitterMs < 0 || maxMemberPages < 1) {
    throw new Error("Unsafe list member pacing or page limit");
  }

  let nextRequestAt = 0;
  const execute = async (request: RelayRequestSpec): Promise<RelayJsonResponse> => {
    const waitMs = Math.max(0, nextRequestAt - nowMs());
    if (waitMs > 0) await sleep(waitMs);
    const response = await fetchImpl(relayUrl(request, options.baseUrl ?? DEFAULT_BASE_URL), {
      method: request.method,
      headers: {
        ...request.headers,
        "accept-encoding": "identity",
        "x-profile-name": options.profileName,
      },
      ...(request.method === "POST"
        ? { body: JSON.stringify(request.data ?? {}) }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    nextRequestAt = nowMs() + minIntervalMs + Math.floor(random() * (jitterMs + 1));
    const payload = await readJson(response);
    if (!response.ok) throw new Error(`Relay HTTP ${response.status}`);
    const errors = graphqlErrors(payload);
    const hasOnlyKnownMutationErrors =
      (request.path.endsWith("/ListAddMember") || request.path.endsWith("/ListRemoveMember")) &&
      errors.every(isKnownListBannerDecodeError);
    if (errors.length > 0 && !hasOnlyKnownMutationErrors) {
      throw new Error("Relay returned GraphQL errors");
    }
    return { response, payload };
  };

  const readAllMembers = async (): Promise<Map<string, string | undefined>> => {
    const members = new Map<string, string | undefined>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxMemberPages; page += 1) {
      const { payload } = await execute(
        buildListMembersRequest(options.requestCatalog, options.listId, cursor),
      );
      const pageMembers = extractListMembers(payload);
      for (const member of pageMembers) {
        members.set(member.twitterId, member.handle);
      }
      if (pageMembers.length < MEMBER_PAGE_SIZE) return members;
      const next = bottomCursor(payload);
      if (!next) return members;
      if (next === cursor || seenCursors.has(next)) {
        throw new Error("ListMembers cursor repeated");
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error("ListMembers exceeded page limit");
  };

  const target = options.catalog.accounts
    .filter(({ status }) => status === "active")
    .map(({ twitterId, handle }) => ({ twitterId, handle }))
    .sort((left, right) => left.twitterId.localeCompare(right.twitterId));
  const before = await readAllMembers();
  const additions = target.filter(({ twitterId }) => !before.has(twitterId));
  const targetIds = new Set(target.map(({ twitterId }) => twitterId));
  const removals = [...before.entries()]
    .filter(([twitterId]) => !targetIds.has(twitterId))
    .map(([twitterId, handle]) => ({ twitterId, handle }))
    .sort((left, right) => left.twitterId.localeCompare(right.twitterId));
  onProgress(
    `current=${before.size} additions=${additions.length} removals=${removals.length}`,
  );

  let added = 0;
  for (const account of additions) {
    await execute(buildRelayRequest(options.requestCatalog, LIST_RELAY_OPERATIONS.addMember, {
      listId: options.listId,
      userId: account.twitterId,
    }));
    added += 1;
    onProgress(`added=${added}/${additions.length} handle=${account.handle}`);
  }

  let removed = 0;
  for (const member of removals) {
    await execute(buildRelayRequest(options.requestCatalog, LIST_RELAY_OPERATIONS.removeMember, {
      listId: options.listId,
      userId: member.twitterId,
    }));
    removed += 1;
    onProgress(`removed=${removed}/${removals.length} member=${member.twitterId}`);
  }

  const after = await readAllMembers();
  const missing = target.filter(({ twitterId }) => !after.has(twitterId));
  const unmanaged = [...after.keys()].filter((twitterId) => !targetIds.has(twitterId));
  if (missing.length > 0 || unmanaged.length > 0) {
    throw new Error(
      `List verification failed: missing=${missing.length} unmanaged=${unmanaged.length}`,
    );
  }
  return { before: before.size, added, removed, after: after.size, verified: true };
}
