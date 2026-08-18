import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelayExecutionPlan,
  executeListTimelineRequest,
} from "../src/relay-client.ts";
import {
  RELAY_REQUEST_CATALOG_SOURCE,
  type RelayRequestSpec,
} from "../src/relay.ts";

function timelineRequest(): RelayRequestSpec {
  return {
    method: "GET",
    path: "/graphql/query-lock/ListLatestTweetsTimeline",
    headers: { "content-type": "application/json" },
    params: {
      variables: JSON.stringify({ listId: "list-1", count: 40, cursor: "secret-cursor" }),
      features: JSON.stringify({ versionLock: true }),
    },
    requestCatalog: {
      source: RELAY_REQUEST_CATALOG_SOURCE.htmlUrl,
      revision: "0".repeat(40),
      contentSha256: "a".repeat(64),
      overridesSha256: "c".repeat(64),
    },
    requestTemplateSha256: "b".repeat(64),
  };
}

test("relay execution plan exposes no query values", () => {
  const plan = createRelayExecutionPlan(
    timelineRequest(),
    "https://tw.home.yutakobayashi.com",
    "account2",
  );
  assert.deepEqual(plan, {
    operation: "ListLatestTweetsTimeline",
    method: "GET",
    origin: "https://tw.home.yutakobayashi.com",
    path: "/i/api/graphql/query-lock/ListLatestTweetsTimeline",
    parameterNames: ["features", "variables"],
    requestCatalogRevision: "0".repeat(40),
    requestTemplateSha256: "b".repeat(64),
    profileName: "account2",
  });
  assert.doesNotMatch(JSON.stringify(plan), /list-1|secret-cursor/);
});

test("relay client preserves response bytes and builds the GraphQL URL", async () => {
  let requestedUrl: URL | undefined;
  const body = Uint8Array.from([0x7b, 0xff, 0x00, 0x7d]);
  const fetchMock: typeof fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
    assert.equal(new Headers(init?.headers).get("x-profile-name"), "account2");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-rate-limit-remaining": "99",
      },
    });
  };

  const response = await executeListTimelineRequest(timelineRequest(), {
    profileName: "account2",
    fetch: fetchMock,
  });
  assert.equal(requestedUrl?.origin, "https://tw.home.yutakobayashi.com");
  assert.equal(
    requestedUrl?.pathname,
    "/i/api/graphql/query-lock/ListLatestTweetsTimeline",
  );
  assert.equal(
    JSON.parse(requestedUrl?.searchParams.get("variables") ?? "{}").cursor,
    "secret-cursor",
  );
  assert.deepEqual(response.body, body);
  assert.equal(response.headers["x-rate-limit-remaining"], "99");
});

test("relay client rejects writes, unsafe origins, and oversized bodies", async () => {
  const write = {
    ...timelineRequest(),
    method: "POST" as const,
    path: "/graphql/delete/DeleteTweet",
  };
  assert.throws(
    () => createRelayExecutionPlan(write, undefined, "account2"),
    /permits only GET ListLatestTweetsTimeline/,
  );
  assert.throws(
    () => createRelayExecutionPlan(
      timelineRequest(),
      "http://tw.home.yutakobayashi.com",
      "account2",
    ),
    /must be an HTTPS origin/,
  );
  assert.throws(
    () => createRelayExecutionPlan(timelineRequest(), undefined, "bad profile"),
    /profile name is invalid/,
  );
  await assert.rejects(
    executeListTimelineRequest(timelineRequest(), {
      profileName: "account2",
      maxBodyBytes: 3,
      fetch: async () => new Response(Uint8Array.from([1, 2, 3, 4])),
    }),
    /exceeds 3 bytes/,
  );
  await assert.rejects(
    executeListTimelineRequest(timelineRequest(), {
      profileName: "account2",
      fetch: async () => new Response("compressed", {
        headers: { "content-encoding": "gzip" },
      }),
    }),
    /unsupported content encoding: gzip/,
  );
});
