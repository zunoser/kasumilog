import {
  LIST_RELAY_OPERATIONS,
  type RelayRequestSpec,
} from "./relay.ts";
import type { RawCaptureResponse } from "./raw.ts";

export const DEFAULT_RELAY_BASE_URL = "https://tw.home.yutakobayashi.com";

export interface RelayExecutionPlan {
  readonly operation: typeof LIST_RELAY_OPERATIONS.timeline;
  readonly method: "GET";
  readonly origin: string;
  readonly path: string;
  readonly parameterNames: readonly string[];
  readonly requestCatalogRevision: string;
  readonly requestTemplateSha256: string;
  readonly profileName: string;
}

export interface RelayClientOptions {
  readonly profileName: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function relayProfileName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new RelayClientPolicyError("Relay profile name is invalid");
  }
  return value;
}

export class RelayClientPolicyError extends Error {
  override readonly name = "RelayClientPolicyError";
}

const TIMELINE_PATH = /^\/graphql\/[A-Za-z0-9_-]+\/ListLatestTweetsTimeline$/;

function relayBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RelayClientPolicyError(
      "Relay base URL must be an HTTPS origin without credentials or a path",
    );
  }
  return url;
}

function assertTimelineRequest(request: RelayRequestSpec): void {
  if (request.method !== "GET" || !TIMELINE_PATH.test(request.path)) {
    throw new RelayClientPolicyError("Relay client permits only GET ListLatestTweetsTimeline");
  }
  if (!request.params || request.data !== undefined) {
    throw new RelayClientPolicyError("Timeline request must contain params and no data body");
  }
  const variables = request.params.variables;
  if (typeof variables !== "string") {
    throw new RelayClientPolicyError("Timeline request variables must be serialized JSON");
  }
  const parsedVariables = JSON.parse(variables) as Record<string, unknown>;
  if (typeof parsedVariables.listId !== "string" || !parsedVariables.listId) {
    throw new RelayClientPolicyError("Timeline request must contain listId");
  }
}

function requestUrl(baseUrl: string, request: RelayRequestSpec): URL {
  assertTimelineRequest(request);
  const base = relayBaseUrl(baseUrl);
  const url = new URL(`/i/api${request.path}`, base);
  for (const [name, rawValue] of Object.entries(request.params ?? {})) {
    if (typeof rawValue !== "string") {
      throw new RelayClientPolicyError(`Relay parameter must be a string: ${name}`);
    }
    url.searchParams.set(name, rawValue);
  }
  return url;
}

export function createRelayExecutionPlan(
  request: RelayRequestSpec,
  baseUrl = DEFAULT_RELAY_BASE_URL,
  profileName: string,
): RelayExecutionPlan {
  const url = requestUrl(baseUrl, request);
  return {
    operation: LIST_RELAY_OPERATIONS.timeline,
    method: "GET",
    origin: url.origin,
    path: url.pathname,
    parameterNames: [...url.searchParams.keys()].sort(),
    requestCatalogRevision: request.requestCatalog.revision,
    requestTemplateSha256: request.requestTemplateSha256,
    profileName: relayProfileName(profileName),
  };
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new RelayClientPolicyError(`Relay response exceeds ${maxBodyBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new RelayClientPolicyError(`Relay response exceeds ${maxBodyBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function executeListTimelineRequest(
  request: RelayRequestSpec,
  options: RelayClientOptions,
): Promise<RawCaptureResponse> {
  const baseUrl = options.baseUrl ?? DEFAULT_RELAY_BASE_URL;
  const profileName = relayProfileName(options.profileName);
  const url = requestUrl(baseUrl, request);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RelayClientPolicyError("Relay timeout must be between 1 and 60000 milliseconds");
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new RelayClientPolicyError("Relay maxBodyBytes must be a positive integer");
  }
  const fetchResponse = await (options.fetch ?? globalThis.fetch)(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      "x-profile-name": profileName,
    },
  });
  const contentEncoding = fetchResponse.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new RelayClientPolicyError(
      `Relay response uses unsupported content encoding: ${contentEncoding}`,
    );
  }
  const headers: Record<string, string> = {};
  fetchResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    status: fetchResponse.status,
    headers,
    body: await readBoundedBody(fetchResponse, maxBodyBytes),
  };
}
