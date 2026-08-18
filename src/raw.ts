import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  RELAY_REQUEST_CATALOG_SOURCE,
  type RelayRequestCatalogIdentity,
} from "./relay.ts";

export interface RawCaptureRequest {
  readonly operation: string;
  readonly profileName: string;
  readonly requestCatalog: RelayRequestCatalogIdentity;
  readonly requestTemplateSha256: string;
  readonly variablesSha256: string;
  readonly cursorIn?: string;
}

export interface RawCaptureResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: Uint8Array;
}

export interface RawCaptureInput {
  readonly fetchId: string;
  readonly runId: string;
  readonly page: number;
  readonly attempt: number;
  readonly listId: string;
  readonly catalogRevision: string;
  readonly listRevision: string;
  readonly requestedAt: string;
  readonly receivedAt: string;
  readonly request: RawCaptureRequest;
  readonly response: RawCaptureResponse;
}

export interface RawFetchManifest {
  readonly schemaVersion: 1;
  readonly fetchId: string;
  readonly runId: string;
  readonly page: number;
  readonly attempt: number;
  readonly source: {
    readonly kind: "list_timeline";
    readonly listId: string;
  };
  readonly request: RawCaptureRequest;
  readonly response: {
    readonly captureLevel: "relay-response-body-v1";
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly excludedHeaderNames: readonly string[];
    readonly bodySha256: string;
    readonly bodyBytes: number;
    readonly storagePath: string;
  };
  readonly catalogRevision: string;
  readonly listRevision: string;
  readonly requestedAt: string;
  readonly receivedAt: string;
}

export interface StoredRawCapture {
  readonly manifest: RawFetchManifest;
  readonly manifestPath: string;
  readonly objectPath: string;
}

export type RawRunStatus = "complete" | "partial" | "failed";

export type RawRunStopReason =
  | "initial_seed"
  | "bootstrap_boundary_reached"
  | "frontier_reached"
  | "exhausted"
  | "item_limit"
  | "page_limit"
  | "request_limit"
  | "wall_clock_limit"
  | "repeated_cursor"
  | "cursor_cycle"
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "decode_error";

const RAW_RUN_STATUSES = new Set<RawRunStatus>(["complete", "partial", "failed"]);
const RAW_RUN_STOP_REASONS = new Set<RawRunStopReason>([
  "initial_seed",
  "bootstrap_boundary_reached",
  "frontier_reached",
  "exhausted",
  "item_limit",
  "page_limit",
  "request_limit",
  "wall_clock_limit",
  "repeated_cursor",
  "cursor_cycle",
  "rate_limited",
  "timeout",
  "upstream_error",
  "decode_error",
]);

export interface RawCoverageFrontier {
  readonly publishedAt: string;
  readonly tweetIds: readonly string[];
}

export interface RawRunPage {
  readonly page: number;
  readonly fetchId: string;
  readonly verifiedCommit: string;
}

export interface RawRunManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly source: {
    readonly kind: "list_timeline";
    readonly listId: string;
  };
  readonly status: RawRunStatus;
  readonly stopReason: RawRunStopReason;
  readonly pages: readonly RawRunPage[];
  readonly coverageFrontier?: RawCoverageFrontier;
  readonly catalogRevision: string;
  readonly listRevision: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lastVerifiedPageCommit?: string;
}

export interface RawRunInput extends Omit<RawRunManifest, "schemaVersion"> {}

export interface StoredRawRun {
  readonly manifest: RawRunManifest;
  readonly manifestPath: string;
}

export interface RecoveredArchiveState {
  readonly latestCompleteRun?: RawRunManifest;
  readonly latestReceivedAt?: string;
  readonly notBefore?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "date",
  "etag",
  "last-modified",
  "retry-after",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
]);

function assertSafeId(label: string, value: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertSha256(label: string, value: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertOnlyKeys(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected ${label} fields: ${unexpected.sort().join(", ")}`);
  }
}

function assertCommit(label: string, value: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function parseTime(label: string, value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid ${label}: ${value}`);
  return timestamp;
}

function sanitizeResponseHeaders(
  headers: RawCaptureResponse["headers"],
): {
  headers: Readonly<Record<string, string>>;
  excludedHeaderNames: readonly string[];
} {
  const kept = new Map<string, string>();
  const excluded = new Set<string>();
  for (const [name, rawValue] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(normalizedName)) {
      excluded.add(normalizedName);
      continue;
    }
    const value = typeof rawValue === "string" ? rawValue : rawValue.join(", ");
    kept.set(normalizedName, value);
  }
  return {
    headers: Object.fromEntries([...kept.entries()].sort()),
    excludedHeaderNames: [...excluded].sort(),
  };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyFile(path: string, expected: Uint8Array): Promise<void> {
  const actual = await readFile(path);
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.equals(Buffer.from(expected))
  ) {
    throw new Error(`Immutable file conflict: ${path}`);
  }
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await link(temporary, path);
      await syncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyFile(path, bytes);
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function storagePath(root: string, absolutePath: string): string {
  const path = relative(resolve(root), absolutePath);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`Storage path escapes root: ${absolutePath}`);
  }
  return path.split(sep).join("/");
}

export async function storeRawCapture(
  root: string,
  input: RawCaptureInput,
): Promise<StoredRawCapture> {
  assertSafeId("fetchId", input.fetchId);
  assertSafeId("runId", input.runId);
  if (!Number.isInteger(input.page) || input.page < 0) {
    throw new Error(`Invalid page: ${input.page}`);
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error(`Invalid attempt: ${input.attempt}`);
  }
  if (
    !Number.isInteger(input.response.status) ||
    input.response.status < 100 ||
    input.response.status > 599
  ) {
    throw new Error(`Invalid HTTP status: ${input.response.status}`);
  }
  if (Number.isNaN(Date.parse(input.requestedAt))) {
    throw new Error(`Invalid requestedAt: ${input.requestedAt}`);
  }
  if (Number.isNaN(Date.parse(input.receivedAt))) {
    throw new Error(`Invalid receivedAt: ${input.receivedAt}`);
  }
  if (Date.parse(input.receivedAt) < Date.parse(input.requestedAt)) {
    throw new Error("receivedAt must not be before requestedAt");
  }
  assertSha256("catalogRevision", input.catalogRevision);
  assertSha256("listRevision", input.listRevision);
  assertSha256("variablesSha256", input.request.variablesSha256);
  assertSha256("requestTemplateSha256", input.request.requestTemplateSha256);
  assertOnlyKeys("request", input.request, [
    "operation",
    "profileName",
    "requestCatalog",
    "requestTemplateSha256",
    "variablesSha256",
    "cursorIn",
  ]);
  assertOnlyKeys("requestCatalog", input.request.requestCatalog, [
    "source",
    "revision",
    "contentSha256",
    "overridesSha256",
  ]);
  assertSafeId("operation", input.request.operation);
  assertSafeId("profileName", input.request.profileName);
  if (input.request.requestCatalog.source !== RELAY_REQUEST_CATALOG_SOURCE.htmlUrl) {
    throw new Error("Unexpected Relay request catalog source");
  }
  if (!/^[0-9a-f]{40}$/.test(input.request.requestCatalog.revision)) {
    throw new Error("Relay request catalog revision must be a commit SHA");
  }
  assertSha256(
    "request catalog contentSha256",
    input.request.requestCatalog.contentSha256,
  );
  assertSha256(
    "request catalog overridesSha256",
    input.request.requestCatalog.overridesSha256,
  );
  const request: RawCaptureRequest = {
    operation: input.request.operation,
    profileName: input.request.profileName,
    requestCatalog: {
      source: input.request.requestCatalog.source,
      revision: input.request.requestCatalog.revision,
      contentSha256: input.request.requestCatalog.contentSha256,
      overridesSha256: input.request.requestCatalog.overridesSha256,
    },
    requestTemplateSha256: input.request.requestTemplateSha256,
    variablesSha256: input.request.variablesSha256,
    ...(input.request.cursorIn ? { cursorIn: input.request.cursorIn } : {}),
  };

  const body = Buffer.from(input.response.body);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const rootPath = resolve(root);
  const objectPath = join(
    rootPath,
    "objects",
    "sha256",
    bodySha256.slice(0, 2),
    `${bodySha256}.bin`,
  );
  const capturedHeaders = sanitizeResponseHeaders(input.response.headers);
  const date = new Date(input.receivedAt);
  const manifestPath = join(
    rootPath,
    "fetches",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    `${input.fetchId}.json`,
  );
  const manifest: RawFetchManifest = {
    schemaVersion: 1,
    fetchId: input.fetchId,
    runId: input.runId,
    page: input.page,
    attempt: input.attempt,
    source: { kind: "list_timeline", listId: input.listId },
    request,
    response: {
      captureLevel: "relay-response-body-v1",
      status: input.response.status,
      headers: capturedHeaders.headers,
      excludedHeaderNames: capturedHeaders.excludedHeaderNames,
      bodySha256,
      bodyBytes: body.byteLength,
      storagePath: storagePath(rootPath, objectPath),
    },
    catalogRevision: input.catalogRevision,
    listRevision: input.listRevision,
    requestedAt: new Date(input.requestedAt).toISOString(),
    receivedAt: date.toISOString(),
  };
  const existingFetch = await readRawFetchManifest(rootPath, input.fetchId);
  if (existingFetch && existingFetch.manifestPath !== manifestPath) {
    throw new Error(`Fetch ID already exists at a different date: ${input.fetchId}`);
  }
  await writeImmutable(objectPath, body);
  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeImmutable(manifestPath, serialized);

  return { manifest, manifestPath, objectPath };
}

export async function readRawFetchManifest(
  root: string,
  fetchId: string,
): Promise<StoredRawCapture | undefined> {
  assertSafeId("fetchId", fetchId);
  const rootPath = resolve(root);
  const matches = (await findJsonFiles(join(rootPath, "fetches")))
    .filter((path) => basename(path) === `${fetchId}.json`);
  if (matches.length > 1) throw new Error(`Duplicate fetch ID: ${fetchId}`);
  if (matches.length === 0) return undefined;
  const manifest = JSON.parse(await readFile(matches[0], "utf8")) as RawFetchManifest;
  const objectPath = resolve(rootPath, manifest.response.storagePath);
  storagePath(rootPath, objectPath);
  return { manifest, manifestPath: matches[0], objectPath };
}

export function rawRunManifestPath(root: string, runId: string, finishedAt: string): string {
  assertSafeId("runId", runId);
  const date = new Date(parseTime("finishedAt", finishedAt));
  return join(
    resolve(root),
    "runs",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    `${runId}.json`,
  );
}

export async function storeRawRun(
  root: string,
  input: RawRunInput,
): Promise<StoredRawRun> {
  const rootPath = resolve(root);
  const startedAt = parseTime("startedAt", input.startedAt);
  const finishedAt = parseTime("finishedAt", input.finishedAt);
  const manifest = validateRawRunManifest({
    schemaVersion: 1,
    runId: input.runId,
    source: { kind: "list_timeline", listId: input.source.listId },
    status: input.status,
    stopReason: input.stopReason,
    pages: input.pages.map(({ page, fetchId, verifiedCommit }) => ({
      page,
      fetchId,
      verifiedCommit,
    })),
    ...(input.coverageFrontier
      ? {
          coverageFrontier: {
            publishedAt: new Date(
              parseTime("coverageFrontier.publishedAt", input.coverageFrontier.publishedAt),
            ).toISOString(),
            tweetIds: [...input.coverageFrontier.tweetIds].sort(),
          },
        }
      : {}),
    catalogRevision: input.catalogRevision,
    listRevision: input.listRevision,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    ...(input.lastVerifiedPageCommit
      ? { lastVerifiedPageCommit: input.lastVerifiedPageCommit }
      : {}),
  });
  const fetchFiles = await findJsonFiles(join(rootPath, "fetches"));
  for (const page of manifest.pages) {
    const matches = fetchFiles.filter((path) => basename(path) === `${page.fetchId}.json`);
    if (matches.length !== 1) {
      throw new Error(`Run must reference one fetch manifest: ${page.fetchId}`);
    }
    const fetch = JSON.parse(await readFile(matches[0], "utf8")) as RawFetchManifest;
    assertRawFetchMatchesRun(fetch, manifest, page);
    await readRawCapture(rootPath, fetch);
  }
  const manifestPath = rawRunManifestPath(rootPath, input.runId, input.finishedAt);
  const existingRun = await readRawRunManifest(rootPath, input.runId);
  if (existingRun && existingRun.manifestPath !== manifestPath) {
    throw new Error(`Run ID already exists at a different date: ${input.runId}`);
  }
  await writeImmutable(
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  return { manifest, manifestPath };
}

export async function readRawRunManifest(
  root: string,
  runId: string,
): Promise<StoredRawRun | undefined> {
  assertSafeId("runId", runId);
  const matches = (await findJsonFiles(join(resolve(root), "runs")))
    .filter((path) => basename(path) === `${runId}.json`);
  if (matches.length > 1) throw new Error(`Duplicate run ID: ${runId}`);
  if (matches.length === 0) return undefined;
  return {
    manifest: validateRawRunManifest(JSON.parse(await readFile(matches[0], "utf8"))),
    manifestPath: matches[0],
  };
}

export function validateRawRunManifest(value: unknown): RawRunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid raw run manifest");
  }
  const manifest = value as Partial<RawRunManifest>;
  assertOnlyKeys("run manifest", value, [
    "schemaVersion",
    "runId",
    "source",
    "status",
    "stopReason",
    "pages",
    "coverageFrontier",
    "catalogRevision",
    "listRevision",
    "startedAt",
    "finishedAt",
    "lastVerifiedPageCommit",
  ]);
  if (manifest.schemaVersion !== 1) throw new Error("Invalid raw run schemaVersion");
  assertSafeId("runId", manifest.runId as string);
  if (!manifest.source || typeof manifest.source !== "object") {
    throw new Error("Invalid raw run source");
  }
  assertOnlyKeys("run source", manifest.source, ["kind", "listId"]);
  if (
    manifest.source.kind !== "list_timeline" ||
    typeof manifest.source.listId !== "string" ||
    !manifest.source.listId
  ) {
    throw new Error("Invalid raw run source");
  }
  if (!RAW_RUN_STATUSES.has(manifest.status as RawRunStatus)) {
    throw new Error(`Invalid run status: ${manifest.status}`);
  }
  if (!RAW_RUN_STOP_REASONS.has(manifest.stopReason as RawRunStopReason)) {
    throw new Error(`Invalid run stop reason: ${manifest.stopReason}`);
  }
  if (
    manifest.status === "complete" &&
    manifest.stopReason !== "initial_seed" &&
    manifest.stopReason !== "bootstrap_boundary_reached" &&
    manifest.stopReason !== "frontier_reached" &&
    manifest.stopReason !== "exhausted"
  ) {
    throw new Error(`A complete run cannot stop with ${manifest.stopReason}`);
  }
  assertSha256("catalogRevision", manifest.catalogRevision as string);
  assertSha256("listRevision", manifest.listRevision as string);
  const startedAt = parseTime("startedAt", manifest.startedAt as string);
  const finishedAt = parseTime("finishedAt", manifest.finishedAt as string);
  if (finishedAt < startedAt) throw new Error("finishedAt must not be before startedAt");
  if (!Array.isArray(manifest.pages)) throw new Error("Invalid raw run pages");
  const fetchIds = new Set<string>();
  manifest.pages.forEach((page, index) => {
    if (!page || typeof page !== "object") throw new Error("Invalid raw run page");
    assertOnlyKeys("run page", page, ["page", "fetchId", "verifiedCommit"]);
    if (page.page !== index) throw new Error("Run pages must be contiguous from page 0");
    assertSafeId("fetchId", page.fetchId);
    if (fetchIds.has(page.fetchId)) throw new Error(`Duplicate fetchId: ${page.fetchId}`);
    fetchIds.add(page.fetchId);
    assertCommit("verifiedCommit", page.verifiedCommit);
  });
  if (manifest.pages.length === 0 && manifest.status !== "failed") {
    throw new Error("A complete or partial run must contain at least one page");
  }
  const lastPage = manifest.pages.at(-1);
  if (lastPage?.verifiedCommit !== manifest.lastVerifiedPageCommit) {
    throw new Error("lastVerifiedPageCommit must match the last page");
  }
  if (manifest.status === "complete" && !manifest.coverageFrontier) {
    throw new Error("A complete run must include a coverage frontier");
  }
  if (manifest.status !== "complete" && manifest.coverageFrontier) {
    throw new Error("Only a complete run may advance the coverage frontier");
  }
  if (manifest.coverageFrontier) {
    assertOnlyKeys("coverage frontier", manifest.coverageFrontier, [
      "publishedAt",
      "tweetIds",
    ]);
    parseTime("coverageFrontier.publishedAt", manifest.coverageFrontier.publishedAt);
    if (!Array.isArray(manifest.coverageFrontier.tweetIds)) {
      throw new Error("Invalid coverage frontier tweetIds");
    }
    const uniqueTweetIds = new Set(manifest.coverageFrontier.tweetIds);
    if (
      uniqueTweetIds.size !== manifest.coverageFrontier.tweetIds.length ||
      manifest.coverageFrontier.tweetIds.some((id) => typeof id !== "string" || !id)
    ) {
      throw new Error("Coverage frontier tweetIds must be unique non-empty strings");
    }
  }
  return manifest as RawRunManifest;
}

export function assertRawFetchMatchesRun(
  fetch: RawFetchManifest,
  run: RawRunManifest,
  page: RawRunPage,
): void {
  if (!Number.isInteger(fetch.attempt) || fetch.attempt < 1) {
    throw new Error(`Invalid fetch attempt: ${fetch.fetchId}`);
  }
  if (
    fetch.fetchId !== page.fetchId ||
    fetch.runId !== run.runId ||
    fetch.page !== page.page ||
    fetch.source.kind !== run.source.kind ||
    fetch.source.listId !== run.source.listId ||
    fetch.catalogRevision !== run.catalogRevision ||
    fetch.listRevision !== run.listRevision
  ) {
    throw new Error(`Fetch manifest does not match run page: ${page.fetchId}`);
  }
}

export async function readRawCapture(
  root: string,
  manifest: RawFetchManifest,
): Promise<Uint8Array> {
  const rootPath = resolve(root);
  const objectPath = resolve(rootPath, manifest.response.storagePath);
  storagePath(rootPath, objectPath);
  const body = await readFile(objectPath);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  if (
    bodySha256 !== manifest.response.bodySha256 ||
    body.byteLength !== manifest.response.bodyBytes
  ) {
    throw new Error(`Raw object verification failed: ${manifest.fetchId}`);
  }
  return body;
}

async function findJsonFiles(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await findJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

function retryAfterTimestamp(manifest: RawFetchManifest): number | undefined {
  const receivedAt = Date.parse(manifest.receivedAt);
  const retryAfter = manifest.response.headers["retry-after"];
  const candidates = [receivedAt + 30_000];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) candidates.push(receivedAt + seconds * 1_000);
    else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) candidates.push(date);
    }
  }
  if (manifest.response.headers["x-rate-limit-remaining"] === "0") {
    const reset = Number(manifest.response.headers["x-rate-limit-reset"]);
    if (Number.isFinite(reset) && reset >= 0) candidates.push(reset * 1_000);
  }
  return Math.max(...candidates);
}

export async function recoverArchiveState(
  root: string,
  options: { readonly listId?: string } = {},
): Promise<RecoveredArchiveState> {
  const rootPath = resolve(root);
  const fetches = await Promise.all(
    (await findJsonFiles(join(rootPath, "fetches"))).map(async (path) => {
      const manifest = JSON.parse(await readFile(path, "utf8")) as RawFetchManifest;
      await readRawCapture(rootPath, manifest);
      return manifest;
    }),
  );
  const runs = await Promise.all(
    (await findJsonFiles(join(rootPath, "runs"))).map(async (path) =>
      validateRawRunManifest(JSON.parse(await readFile(path, "utf8")))
    ),
  );
  const fetchesById = new Map(fetches.map((fetch) => [fetch.fetchId, fetch]));
  if (fetchesById.size !== fetches.length) throw new Error("Duplicate fetch IDs in archive");
  const runIds = new Set(runs.map(({ runId }) => runId));
  if (runIds.size !== runs.length) throw new Error("Duplicate run IDs in archive");
  for (const run of runs) {
    for (const page of run.pages) {
      const fetch = fetchesById.get(page.fetchId);
      if (!fetch) throw new Error(`Run is missing fetch manifest: ${page.fetchId}`);
      assertRawFetchMatchesRun(fetch, run, page);
    }
  }
  const latestFetch = fetches.sort((left, right) =>
    left.receivedAt.localeCompare(right.receivedAt)
  ).at(-1);
  const latestCompleteRun = runs
    .filter(({ status, source }) =>
      status === "complete" &&
      (!options.listId || source.listId === options.listId)
    )
    .sort((left, right) => left.finishedAt.localeCompare(right.finishedAt))
    .at(-1);
  const notBefore = latestFetch ? retryAfterTimestamp(latestFetch) : undefined;
  return {
    ...(latestCompleteRun ? { latestCompleteRun } : {}),
    ...(latestFetch ? { latestReceivedAt: latestFetch.receivedAt } : {}),
    ...(notBefore !== undefined ? { notBefore: new Date(notBefore).toISOString() } : {}),
  };
}
