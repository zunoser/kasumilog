import { createHash } from "node:crypto";

import type { Catalog } from "./model.ts";
import {
  RELAY_REQUEST_OVERRIDE_SET,
  type RelayOperationOverride,
} from "./relay-overrides.ts";
import {
  assertPlanMatchesCatalog,
  type ListSyncPlan,
  type RemoteListMember,
} from "./sync.ts";

export type RelayMethod = "GET" | "POST";

interface RelayHttpRequest {
  readonly method: RelayMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RelayRequestCatalogIdentity {
  readonly source: typeof RELAY_REQUEST_CATALOG_SOURCE.htmlUrl;
  readonly revision: string;
  readonly contentSha256: string;
  readonly overridesSha256: string;
}

export interface RelayRequestCatalog {
  readonly identity: RelayRequestCatalogIdentity;
  readonly content: string;
}

export interface RelayRequestSpec extends RelayHttpRequest {
  readonly requestCatalog: RelayRequestCatalogIdentity;
  readonly requestTemplateSha256: string;
}

interface RelayCatalogEntry extends RelayHttpRequest {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
}

export const RELAY_REQUEST_CATALOG_SOURCE = {
  owner: "fa0311",
  repository: "twitter_api_safe_relay_skills",
  branch: "main",
  path: "skills/twitter-api-relay/requests.ndjson",
  htmlUrl:
    "https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson",
} as const;

export const LIST_RELAY_OPERATIONS = {
  create: "CreateList",
  members: "ListMembers",
  addMember: "ListAddMember",
  removeMember: "ListRemoveMember",
  timeline: "ListLatestTweetsTimeline",
} as const;

export const RELAY_REQUEST_OVERRIDES_SHA256 = createHash("sha256")
  .update(JSON.stringify(RELAY_REQUEST_OVERRIDE_SET), "utf8")
  .digest("hex");

function operationName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function buildPinnedRelayRequestCatalogUrl(revision: string): string {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`Relay request catalog revision must be a commit SHA: ${revision}`);
  }
  const { owner, repository, path } = RELAY_REQUEST_CATALOG_SOURCE;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${path}`;
}

function parseEntries(content: string): readonly RelayCatalogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const entry = JSON.parse(line) as Partial<RelayCatalogEntry>;
      if (
        (entry.method !== "GET" && entry.method !== "POST") ||
        typeof entry.path !== "string" ||
        (entry.headers !== undefined && typeof entry.headers !== "object")
      ) {
        throw new Error(`Invalid Relay request catalog entry at line ${index + 1}`);
      }
      return {
        ...entry,
        headers: entry.headers ?? {},
      } as RelayCatalogEntry;
    });
}

export function createRelayRequestCatalog(
  content: string,
  revision: string,
): RelayRequestCatalog {
  buildPinnedRelayRequestCatalogUrl(revision);
  const entries = parseEntries(content);
  const operationCounts = new Map<string, number>();
  for (const entry of entries) {
    const operation = operationName(entry.path);
    operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1);
  }
  for (const operation of Object.values(LIST_RELAY_OPERATIONS)) {
    if (operationCounts.get(operation) !== 1) {
      throw new Error(`Relay request catalog must contain one ${operation} entry`);
    }
  }
  return {
    identity: {
      source: RELAY_REQUEST_CATALOG_SOURCE.htmlUrl,
      revision,
      contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      overridesSha256: RELAY_REQUEST_OVERRIDES_SHA256,
    },
    content,
  };
}

function applyLocalOverride(
  template: RelayCatalogEntry,
  operation: string,
): RelayCatalogEntry {
  const override = (
    RELAY_REQUEST_OVERRIDE_SET.operations as Readonly<
      Record<string, RelayOperationOverride | undefined>
    >
  )[operation];
  if (!override) return template;

  const path = `/graphql/${override.queryId}/${operation}`;
  if (template.method === "POST") {
    return {
      ...template,
      path,
      data: {
        ...template.data,
        variables: override.variables ?? {},
        queryId: override.queryId,
        features: override.features,
      },
    };
  }

  const params = template.params ?? {};
  if (typeof params.variables !== "string") {
    throw new Error(`Relay GET operation has no variables: ${operation}`);
  }
  return {
    ...template,
    path,
    params: {
      ...params,
      variables: JSON.stringify(override.variables ?? {}),
      features: JSON.stringify(override.features),
    },
  };
}

function findTemplate(
  catalog: RelayRequestCatalog,
  operation: string,
): { template: RelayCatalogEntry; templateSha256: string } {
  const line = catalog.content
    .split("\n")
    .filter((entry) => entry.trim())
    .find((entry) => {
      const parsed = JSON.parse(entry) as Partial<RelayCatalogEntry>;
      return typeof parsed.path === "string" && operationName(parsed.path) === operation;
    });
  if (!line) {
    throw new Error(`Relay operation not found: ${operation}`);
  }
  const template = applyLocalOverride(
    JSON.parse(line) as RelayCatalogEntry,
    operation,
  );
  return {
    template,
    templateSha256: createHash("sha256")
      .update(JSON.stringify(template), "utf8")
      .digest("hex"),
  };
}

export function buildRelayRequest(
  catalog: RelayRequestCatalog,
  operation: string,
  variableOverrides: Readonly<Record<string, unknown>>,
): RelayRequestSpec {
  const { template, templateSha256 } = findTemplate(catalog, operation);

  if (template.method === "POST") {
    const data = template.data ?? {};
    const variables = (data.variables ?? {}) as Readonly<Record<string, unknown>>;
    return {
      ...template,
      requestCatalog: catalog.identity,
      requestTemplateSha256: templateSha256,
      data: {
        ...data,
        variables: { ...variables, ...variableOverrides },
      },
    };
  }

  const params = template.params ?? {};
  const serializedVariables = params.variables;
  if (typeof serializedVariables !== "string") {
    throw new Error(`Relay GET operation has no variables: ${operation}`);
  }
  const variables = JSON.parse(serializedVariables) as Record<string, unknown>;

  return {
    ...template,
    requestCatalog: catalog.identity,
    requestTemplateSha256: templateSha256,
    params: {
      ...params,
      variables: JSON.stringify({ ...variables, ...variableOverrides }),
    },
  };
}

export function buildCreateListRequest(
  requestCatalog: RelayRequestCatalog,
  name: string,
  description: string,
  isPrivate: boolean,
): RelayRequestSpec {
  return buildRelayRequest(requestCatalog, LIST_RELAY_OPERATIONS.create, {
    name,
    description,
    isPrivate,
  });
}

export function buildListMembersRequest(
  requestCatalog: RelayRequestCatalog,
  listId: string,
  cursor?: string,
): RelayRequestSpec {
  return buildRelayRequest(requestCatalog, LIST_RELAY_OPERATIONS.members, {
    listId,
    cursor,
  });
}

export function buildListTimelineRequest(
  requestCatalog: RelayRequestCatalog,
  listId: string,
  cursor?: string,
): RelayRequestSpec {
  return buildRelayRequest(requestCatalog, LIST_RELAY_OPERATIONS.timeline, {
    listId,
    cursor,
  });
}

export function buildListMutationRequests(
  requestCatalog: RelayRequestCatalog,
  catalog: Catalog,
  plan: ListSyncPlan,
): readonly RelayRequestSpec[] {
  assertPlanMatchesCatalog(catalog, plan);
  return [
    ...plan.additions.map(({ twitterId }) =>
      buildRelayRequest(requestCatalog, LIST_RELAY_OPERATIONS.addMember, {
        listId: plan.listId,
        userId: twitterId,
      }),
    ),
    ...plan.removals.map(({ twitterId }) =>
      buildRelayRequest(requestCatalog, LIST_RELAY_OPERATIONS.removeMember, {
        listId: plan.listId,
        userId: twitterId,
      }),
    ),
  ];
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

export function extractListMembers(payload: unknown): readonly RemoteListMember[] {
  const members = new Map<string, RemoteListMember>();
  visitObjects(payload, (object) => {
    const legacy = object.legacy;
    const core = object.core;
    const legacyHandle = legacy && typeof legacy === "object"
      ? (legacy as Record<string, unknown>).screen_name
      : undefined;
    const coreHandle = core && typeof core === "object"
      ? (core as Record<string, unknown>).screen_name
      : undefined;
    const handle = typeof coreHandle === "string" ? coreHandle : legacyHandle;
    if (typeof object.rest_id === "string" && typeof handle === "string") {
      members.set(object.rest_id, {
        twitterId: object.rest_id,
        handle,
      });
    }
  });
  return [...members.values()].sort((left, right) =>
    left.twitterId.localeCompare(right.twitterId),
  );
}
