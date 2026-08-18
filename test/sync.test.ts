import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { extractArchiveBatch, mergeArchive, parseArchive, serializeArchive } from "../src/archive.ts";
import { catalog } from "../src/catalog.ts";
import {
  buildCreateListRequest,
  buildListMembersRequest,
  buildListMutationRequests,
  buildListTimelineRequest,
  buildPinnedRelayRequestCatalogUrl,
  createRelayRequestCatalog,
  extractListMembers,
  RELAY_REQUEST_CATALOG_SOURCE,
  RELAY_REQUEST_OVERRIDES_SHA256,
} from "../src/relay.ts";
import {
  assertPlanMatchesCatalog,
  createCatalogRevision,
  createCatalogSnapshot,
  createListRevision,
  createListSyncPlan,
  createRemoteListSnapshot,
  diffCatalogSnapshots,
  formatListSyncPlan,
  parseCatalogSnapshot,
  parseRemoteListSnapshot,
  serializeCatalogSnapshot,
  serializeRemoteListSnapshot,
} from "../src/sync.ts";

const relayCatalogContent = [
  {
    method: "POST",
    path: "/graphql/create/CreateList",
    headers: { "content-type": "application/json" },
    data: {
      variables: { name: "old", description: "old", isPrivate: true },
      features: { versionLock: true },
      queryId: "create-lock",
    },
  },
  {
    method: "GET",
    path: "/graphql/members/ListMembers",
    headers: { "content-type": "application/json" },
    params: {
      variables: JSON.stringify({ listId: "old", count: 20, cursor: "sample-members" }),
      features: JSON.stringify({ versionLock: true }),
    },
  },
  {
    method: "POST",
    path: "/graphql/add/ListAddMember",
    headers: { "content-type": "application/json" },
    data: {
      variables: { listId: "old", userId: "old" },
      features: { versionLock: true },
      queryId: "add-lock",
    },
  },
  {
    method: "POST",
    path: "/graphql/remove/ListRemoveMember",
    headers: { "content-type": "application/json" },
    data: {
      variables: { listId: "old", userId: "old" },
      features: { versionLock: true },
      queryId: "remove-lock",
    },
  },
  {
    method: "GET",
    path: "/graphql/timeline/ListLatestTweetsTimeline",
    headers: { "content-type": "application/json" },
    params: {
      variables: JSON.stringify({ listId: "old", count: 20, cursor: "sample-timeline" }),
      features: JSON.stringify({ versionLock: true }),
    },
  },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");
const relayCatalogRevision = "0".repeat(40);
const relayCatalog = createRelayRequestCatalog(
  relayCatalogContent,
  relayCatalogRevision,
);

test("catalog and active-list revisions cover different dimensions", () => {
  const catalogRevision = createCatalogRevision(catalog);
  const listRevision = createListRevision(catalog);
  const renamed = {
    ...catalog,
    accounts: catalog.accounts.map((account, index) =>
      index === 0 ? { ...account, displayName: "changed" } : account
    ),
  };
  assert.notEqual(createCatalogRevision(renamed), catalogRevision);
  assert.equal(createListRevision(renamed), listRevision);
  const retired = {
    ...catalog,
    accounts: catalog.accounts.map((account, index) =>
      index === 0 ? { ...account, status: "inactive" as const } : account
    ),
  };
  assert.notEqual(createListRevision(retired), listRevision);
});

test("catalog snapshots expose added and changed accounts", () => {
  const beforeCatalog = { ...catalog, accounts: catalog.accounts.slice(0, -1) };
  const before = createCatalogSnapshot(beforeCatalog, "2026-08-17T00:00:00Z");
  const after = createCatalogSnapshot(catalog, "2026-08-18T00:00:00Z");
  const diff = diffCatalogSnapshots(before, after);

  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0]?.twitterId, "1401738180202622982");
  assert.deepEqual(parseCatalogSnapshot(serializeCatalogSnapshot(after)), after);
});

test("only a complete remote snapshot can produce an exact sync plan", () => {
  const incomplete = createRemoteListSnapshot(
    "list-1",
    "2026-08-17T00:00:00Z",
    [{ twitterId: "412940784", handle: "kantei" }],
    false,
  );
  assert.throws(
    () => createListSyncPlan(catalog, incomplete),
    /incomplete list snapshot/,
  );

  const complete = createRemoteListSnapshot(
    "list-1",
    "2026-08-17T00:00:00Z",
    [
      { twitterId: "412940784", handle: "kantei" },
      { twitterId: "999", handle: "manual_member" },
    ],
    true,
  );
  const plan = createListSyncPlan(catalog, complete);

  assert.doesNotThrow(() => assertPlanMatchesCatalog(catalog, plan));
  assert.deepEqual(
    parseRemoteListSnapshot(serializeRemoteListSnapshot(complete)),
    complete,
  );
  assert.equal(
    plan.additions.length,
    catalog.accounts.filter(({ status }) => status === "active").length - 1,
  );
  assert.deepEqual(plan.removals, [
    { twitterId: "999", handle: "manual_member" },
  ]);
  assert.equal(plan.unchanged.length, 1);
  assert.match(formatListSyncPlan(plan), /\+ @cao_japan/);
  assert.match(formatListSyncPlan(plan), /- @manual_member \(999\)/);
});

test("relay request builders apply reviewed local version locks", () => {
  const create = buildCreateListRequest(relayCatalog, "霞が関", "official", true);
  const members = buildListMembersRequest(relayCatalog, "list-1", "cursor-1");
  const membersHead = buildListMembersRequest(relayCatalog, "list-1");
  const timeline = buildListTimelineRequest(relayCatalog, "list-1");
  const snapshot = createRemoteListSnapshot(
    "list-1",
    "2026-08-17T00:00:00Z",
    [{ twitterId: "999" }],
    true,
  );
  const plan = createListSyncPlan(catalog, snapshot);
  const mutations = buildListMutationRequests(relayCatalog, catalog, plan);

  assert.equal((create.data?.queryId as string), "create-lock");
  assert.deepEqual(create.data?.features, { versionLock: true });
  assert.equal(
    members.path,
    "/graphql/8rYmkvWQe9jRRZdy_-vkGA/ListMembers",
  );
  assert.equal(
    JSON.parse(members.params?.features as string)
      .responsive_web_profile_redirect_enabled,
    true,
  );
  assert.equal(
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled" in
      JSON.parse(members.params?.features as string),
    false,
  );
  assert.equal(
    JSON.parse(members.params?.variables as string).cursor,
    "cursor-1",
  );
  assert.equal("cursor" in JSON.parse(membersHead.params?.variables as string), false);
  assert.equal("cursor" in JSON.parse(timeline.params?.variables as string), false);
  assert.equal(JSON.parse(timeline.params?.variables as string).count, 20);
  assert.equal(
    timeline.path,
    "/graphql/1LE3u14FJjPZUHKFGzos2g/ListLatestTweetsTimeline",
  );
  assert.equal(
    JSON.parse(timeline.params?.features as string).post_ctas_fetch_enabled,
    false,
  );
  assert.equal(mutations[0]?.data?.queryId, "V2yIKI9d6o_9D9rJ9-a-2w");
  assert.equal(
    mutations[0]?.path,
    "/graphql/V2yIKI9d6o_9D9rJ9-a-2w/ListAddMember",
  );
  assert.deepEqual(mutations[0]?.data?.features, {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  });
  assert.equal(mutations.at(-1)?.data?.queryId, "NYsw9xBA6rSMA3N5sccSJA");
  assert.equal(
    mutations.at(-1)?.path,
    "/graphql/NYsw9xBA6rSMA3N5sccSJA/ListRemoveMember",
  );
  assert.match(timeline.requestTemplateSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(timeline.requestCatalog, {
    source: RELAY_REQUEST_CATALOG_SOURCE.htmlUrl,
    revision: relayCatalogRevision,
    contentSha256: createHash("sha256")
      .update(relayCatalogContent, "utf8")
      .digest("hex"),
    overridesSha256: RELAY_REQUEST_OVERRIDES_SHA256,
  });
  assert.equal(
    buildPinnedRelayRequestCatalogUrl(relayCatalogRevision),
    `https://raw.githubusercontent.com/fa0311/twitter_api_safe_relay_skills/${relayCatalogRevision}/skills/twitter-api-relay/requests.ndjson`,
  );
  assert.throws(
    () => createRelayRequestCatalog(relayCatalogContent, "main"),
    /commit SHA/,
  );
});

test("list member extraction deduplicates Twitter IDs", () => {
  const payload = {
    users: [
      { rest_id: "1", legacy: { screen_name: "one" } },
      { rest_id: "1", legacy: { screen_name: "one" } },
      { rest_id: "2", core: { screen_name: "two" } },
    ],
  };
  assert.deepEqual(extractListMembers(payload), [
    { twitterId: "1", handle: "one" },
    { twitterId: "2", handle: "two" },
  ]);
});

test("timeline archive keeps unknown publishers and embedded repost provenance", () => {
  const payload = {
    entries: [
      {
        rest_id: "tweet-1",
        core: {
          user_results: {
            result: {
              rest_id: "412940784",
              legacy: { screen_name: "kantei" },
            },
          },
        },
        legacy: {
          full_text: "RT @outside: source",
          created_at: "Mon Aug 17 03:00:00 +0000 2026",
          retweeted_status_result: {
            result: {
              rest_id: "source-1",
              core: {
                user_results: {
                  result: {
                    rest_id: "777",
                    legacy: { screen_name: "outside" },
                  },
                },
              },
              legacy: {
                full_text: "source",
                created_at: "Mon Aug 17 02:00:00 +0000 2026",
              },
            },
          },
        },
      },
      {
        rest_id: "tweet-2",
        core: {
          user_results: {
            result: {
              rest_id: "888",
              legacy: { screen_name: "promoted_or_unknown" },
            },
          },
        },
        legacy: {
          full_text: "unknown",
          created_at: "Mon Aug 17 04:00:00 +0000 2026",
        },
      },
      { cursorType: "Bottom", value: "next-page" },
    ],
  };
  const first = extractArchiveBatch(
    payload,
    catalog,
    "list-1",
    "2026-08-17T05:00:00Z",
  );

  assert.equal(first.posts.length, 2);
  assert.equal(first.posts[0]?.repostOf?.tweetId, "source-1");
  assert.equal(first.posts[0]?.metadata?.organization, "cabinet_secretariat");
  assert.equal(first.posts[1]?.metadata, undefined);
  assert.deepEqual(first.unknownAuthorIds, ["888"]);
  assert.equal(first.nextCursor, "next-page");

  const second = first.posts.map((post) => ({
    ...post,
    lastCollectedAt: "2026-08-17T06:00:00Z",
  }));
  const merged = mergeArchive(first.posts, second);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.firstCollectedAt, "2026-08-17T05:00:00Z");
  assert.equal(merged[0]?.lastCollectedAt, "2026-08-17T06:00:00Z");
  assert.deepEqual(parseArchive(serializeArchive(merged)), merged);
});
