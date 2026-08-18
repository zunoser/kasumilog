import { createHash } from "node:crypto";

import type { Account, Catalog } from "./model.ts";

export interface CatalogAccountState {
  readonly id: string;
  readonly twitterId: string;
  readonly handle: string;
  readonly status: Account["status"];
  readonly verifiedAt: string;
}

export interface CatalogSnapshot {
  readonly version: 1;
  readonly createdAt: string;
  readonly accounts: readonly CatalogAccountState[];
}

export interface CatalogAccountChange {
  readonly before: CatalogAccountState;
  readonly after: CatalogAccountState;
}

export interface CatalogDiff {
  readonly added: readonly CatalogAccountState[];
  readonly removed: readonly CatalogAccountState[];
  readonly changed: readonly CatalogAccountChange[];
}

export interface RemoteListMember {
  readonly twitterId: string;
  readonly handle?: string;
}

export interface RemoteListSnapshot {
  readonly version: 1;
  readonly listId: string;
  readonly observedAt: string;
  readonly complete: boolean;
  readonly members: readonly RemoteListMember[];
}

export interface ListSyncPlan {
  readonly listId: string;
  readonly catalogFingerprint: string;
  readonly observedAt: string;
  readonly additions: readonly Account[];
  readonly removals: readonly RemoteListMember[];
  readonly unchanged: readonly Account[];
}

const byTwitterId = <T extends { readonly twitterId: string }>(left: T, right: T) =>
  left.twitterId.localeCompare(right.twitterId);

export function createCatalogSnapshot(
  catalog: Catalog,
  createdAt: string,
): CatalogSnapshot {
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid snapshot createdAt: ${createdAt}`);
  }

  return {
    version: 1,
    createdAt,
    accounts: catalog.accounts
      .map(({ id, twitterId, handle, status, verifiedAt }) => ({
        id,
        twitterId,
        handle,
        status,
        verifiedAt,
      }))
      .sort(byTwitterId),
  };
}

export function diffCatalogSnapshots(
  before: CatalogSnapshot,
  after: CatalogSnapshot,
): CatalogDiff {
  const beforeById = new Map(before.accounts.map((account) => [account.id, account]));
  const afterById = new Map(after.accounts.map((account) => [account.id, account]));
  const added = after.accounts.filter(({ id }) => !beforeById.has(id));
  const removed = before.accounts.filter(({ id }) => !afterById.has(id));
  const changed = after.accounts.flatMap((account) => {
    const previous = beforeById.get(account.id);
    return previous && JSON.stringify(previous) !== JSON.stringify(account)
      ? [{ before: previous, after: account }]
      : [];
  });

  return { added, removed, changed };
}

export function createListSyncPlan(
  catalog: Catalog,
  snapshot: RemoteListSnapshot,
): ListSyncPlan {
  if (!snapshot.complete) {
    throw new Error("Cannot plan sync from an incomplete list snapshot");
  }
  const desired = catalog.accounts.filter(({ status }) => status === "active");
  const desiredIds = new Set(desired.map(({ twitterId }) => twitterId));
  const remoteIds = new Set(snapshot.members.map(({ twitterId }) => twitterId));

  return {
    listId: snapshot.listId,
    catalogFingerprint: createCatalogFingerprint(catalog),
    observedAt: snapshot.observedAt,
    additions: desired.filter(({ twitterId }) => !remoteIds.has(twitterId)).sort(byTwitterId),
    removals: snapshot.members
      .filter(({ twitterId }) => !desiredIds.has(twitterId))
      .sort(byTwitterId),
    unchanged: desired.filter(({ twitterId }) => remoteIds.has(twitterId)).sort(byTwitterId),
  };
}

export function createCatalogFingerprint(catalog: Catalog): string {
  return catalog.accounts
    .map(({ twitterId, status }) => `${twitterId}:${status}`)
    .sort()
    .join(",");
}

export function createCatalogRevision(catalog: Catalog): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

export function createListRevision(catalog: Catalog): string {
  const activeTwitterIds = catalog.accounts
    .filter(({ status }) => status === "active")
    .map(({ twitterId }) => twitterId)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify(activeTwitterIds))
    .digest("hex");
}

export function createRemoteListSnapshot(
  listId: string,
  observedAt: string,
  members: readonly RemoteListMember[],
  complete: boolean,
): RemoteListSnapshot {
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error(`Invalid snapshot observedAt: ${observedAt}`);
  }
  const uniqueMembers = new Map(members.map((member) => [member.twitterId, member]));
  return {
    version: 1,
    listId,
    observedAt,
    complete,
    members: [...uniqueMembers.values()].sort(byTwitterId),
  };
}

export function assertPlanMatchesCatalog(catalog: Catalog, plan: ListSyncPlan): void {
  if (createCatalogFingerprint(catalog) !== plan.catalogFingerprint) {
    throw new Error("Catalog changed after the sync plan was created");
  }
}

export function formatListSyncPlan(plan: ListSyncPlan): string {
  const lines = [
    `list: ${plan.listId}`,
    `observed: ${plan.observedAt}`,
    `add: ${plan.additions.length}`,
    ...plan.additions.map(({ handle, twitterId }) => `  + ${handle} (${twitterId})`),
    `remove: ${plan.removals.length}`,
    ...plan.removals.map(
      ({ handle, twitterId }) => `  - ${handle ? `@${handle.replace(/^@/, "")}` : twitterId} (${twitterId})`,
    ),
    `unchanged: ${plan.unchanged.length}`,
  ];

  return `${lines.join("\n")}\n`;
}

export function serializeCatalogSnapshot(snapshot: CatalogSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseCatalogSnapshot(serialized: string): CatalogSnapshot {
  const snapshot = JSON.parse(serialized) as CatalogSnapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.accounts)) {
    throw new Error("Invalid catalog snapshot");
  }
  return snapshot;
}

export function serializeRemoteListSnapshot(snapshot: RemoteListSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseRemoteListSnapshot(serialized: string): RemoteListSnapshot {
  const snapshot = JSON.parse(serialized) as RemoteListSnapshot;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.listId !== "string" ||
    !Array.isArray(snapshot.members)
  ) {
    throw new Error("Invalid remote list snapshot");
  }
  return snapshot;
}
