import assert from "node:assert/strict";
import test from "node:test";

import { catalog } from "../src/catalog.ts";
import { syncListMembers } from "../src/list-member-sync.ts";
import { createRelayRequestCatalog } from "../src/relay.ts";

const requestCatalog = createRelayRequestCatalog([
  ["POST", "CreateList", { variables: {} }],
  ["GET", "ListMembers", JSON.stringify({ listId: "old", count: 20 })],
  ["POST", "ListAddMember", { variables: {} }],
  ["POST", "ListRemoveMember", { variables: {} }],
  ["GET", "ListLatestTweetsTimeline", JSON.stringify({ listId: "old", count: 20 })],
].map(([method, operation, variables]) => JSON.stringify({
  method,
  path: `/graphql/old/${operation}`,
  headers: { "content-type": "application/json" },
  ...(method === "GET"
    ? { params: { variables, features: "{}" } }
    : { data: variables }),
})).join("\n"), "0".repeat(40));

function membersPayload(ids: readonly string[]) {
  return {
    data: {
      users: ids.map((id) => ({
        rest_id: id,
        legacy: { screen_name: `user_${id}` },
      })),
    },
  };
}

const knownBannerDecodeError = {
  code: 214,
  message: "BadRequest: com.twitter.strato.serialization.DecodeException",
  path: ["list", "default_banner_media_results", "result"],
};

test("member sync adds missing and removes unmanaged members sequentially", async () => {
  const targets = catalog.accounts
    .filter(({ status }) => status === "active")
    .map(({ twitterId }) => twitterId)
    .sort();
  const missing = targets[0] as string;
  const remote = new Set(targets.slice(1));
  remote.add("unmanaged-extra");
  const starts: number[] = [];
  let now = 0;
  let addCount = 0;
  let removeCount = 0;

  const fetchMock: typeof fetch = async (input, init) => {
    starts.push(now);
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("x-profile-name"), "account2");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { variables: { listId: string; userId: string } };
      assert.equal(body.variables.listId, "2089423174601670906");
      if (url.pathname.endsWith("/ListAddMember")) {
        addCount += 1;
        assert.equal(body.variables.userId, missing);
        remote.add(body.variables.userId);
      } else {
        removeCount += 1;
        assert.equal(
          url.pathname,
          "/i/api/graphql/NYsw9xBA6rSMA3N5sccSJA/ListRemoveMember",
        );
        assert.equal(body.variables.userId, "unmanaged-extra");
        remote.delete(body.variables.userId);
      }
      return Response.json({ data: {}, errors: [knownBannerDecodeError] });
    }
    assert.equal(url.pathname, "/i/api/graphql/8rYmkvWQe9jRRZdy_-vkGA/ListMembers");
    return Response.json(membersPayload([...remote]));
  };

  const result = await syncListMembers({
    catalog,
    requestCatalog,
    listId: "2089423174601670906",
    profileName: "account2",
  }, {
    fetch: fetchMock,
    nowMs: () => now,
    random: () => 0,
    sleep: async (milliseconds) => { now += milliseconds; },
  });

  assert.equal(addCount, 1);
  assert.equal(removeCount, 1);
  assert.deepEqual(result, {
    before: targets.length,
    added: 1,
    removed: 1,
    after: targets.length,
    verified: true,
  });
  assert.deepEqual(starts, [0, 15_000, 30_000, 45_000]);
});

test("member sync stops before writes on GraphQL errors or unsafe targets", async () => {
  let calls = 0;
  await assert.rejects(
    syncListMembers({
      catalog,
      requestCatalog,
      listId: "2089423174601670906",
      profileName: "account2",
    }, {
      fetch: async () => {
        calls += 1;
        return Response.json({ errors: [{ message: "failed" }] });
      },
    }),
    /GraphQL errors/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    syncListMembers({
      catalog,
      requestCatalog,
      listId: "wrong-list",
      profileName: "account2",
    }),
    /locked to account2/,
  );
});

test("member sync rejects unknown mutation errors", async () => {
  const first = catalog.accounts.find(({ status }) => status === "active");
  assert.ok(first);
  const singleTargetCatalog = {
    ...catalog,
    accounts: catalog.accounts.map((account) => ({
      ...account,
      status: account.twitterId === first.twitterId ? "active" as const : "inactive" as const,
    })),
  };
  let calls = 0;
  let now = 0;
  await assert.rejects(
    syncListMembers({
      catalog: singleTargetCatalog,
      requestCatalog,
      listId: "2089423174601670906",
      profileName: "account2",
    }, {
      fetch: async (_input, init) => {
        calls += 1;
        if (init?.method === "POST") {
          return Response.json({ errors: [{ code: 999, message: "different failure" }] });
        }
        return Response.json(membersPayload([]));
      },
      nowMs: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      random: () => 0,
    }),
    /GraphQL errors/,
  );
  assert.equal(calls, 2);
});

test("member sync accepts current core handles and stops on a short member page", async () => {
  const first = catalog.accounts.find(({ status }) => status === "active");
  assert.ok(first);
  const singleTargetCatalog = {
    ...catalog,
    accounts: catalog.accounts.map((account) => ({
      ...account,
      status: account.twitterId === first.twitterId ? "active" as const : "inactive" as const,
    })),
  };
  let calls = 0;
  const result = await syncListMembers({
    catalog: singleTargetCatalog,
    requestCatalog,
    listId: "2089423174601670906",
    profileName: "account2",
  }, {
    fetch: async () => {
      calls += 1;
      return Response.json({
        data: {
          entries: [
            {
              rest_id: first.twitterId,
              core: { screen_name: first.handle },
            },
            {
              content: {
                cursorType: "Bottom",
                value: `cursor-${calls}`,
              },
            },
          ],
        },
      });
    },
    sleep: async () => {},
    nowMs: () => calls * 30_000,
    random: () => 0,
  });

  assert.equal(calls, 2);
  assert.deepEqual(result, {
    before: 1,
    added: 0,
    removed: 0,
    after: 1,
    verified: true,
  });
});
