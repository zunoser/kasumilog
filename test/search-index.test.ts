import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ArchivedPost } from "../src/archive.ts";
import { catalog } from "../src/catalog.ts";
import { storeRawCapture } from "../src/raw.ts";
import {
  rebuildSearchIndex,
  rebuildSearchIndexFromRaw,
  searchIndex,
} from "../src/search-index.ts";

function post(tweetId: string, publishedAt: string, text: string): ArchivedPost {
  return {
    schemaVersion: 1,
    listId: "list-1",
    tweetId,
    publisher: {
      twitterId: "412940784",
      handle: "@kantei",
      catalogAccountId: "twitter:412940784",
    },
    text,
    publishedAt,
    firstCollectedAt: "2026-08-18T01:00:00.000Z",
    lastCollectedAt: "2026-08-18T01:00:00.000Z",
    metadata: {
      publisher: "twitter:412940784",
      publishedAt,
      organization: "cabinet_secretariat",
      government: "japan",
      domain: "administration",
      classifiedBy: "account",
    },
  };
}

test("FTS trigram and short Japanese fallback find local posts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-search-"));
  try {
    const database = join(directory, "search.sqlite");
    await rebuildSearchIndex(database, [
      post("100", "2026-08-18T00:00:00.000Z", "内閣総理大臣の記者会見"),
      post("200", "2026-08-18T00:01:00.000Z", "総理発言を掲載しました"),
    ], catalog);

    assert.deepEqual(
      searchIndex({ databasePath: database, query: "総理大臣" }).items.map(({ tweetId }) => tweetId),
      ["100"],
    );
    assert.deepEqual(
      searchIndex({ databasePath: database, query: "総理" }).items.map(({ tweetId }) => tweetId),
      ["200", "100"],
    );
    assert.deepEqual(
      searchIndex({ databasePath: database, query: "内閣官房" }).items.map(({ tweetId }) => tweetId),
      ["200", "100"],
    );

    await rebuildSearchIndex(database, [
      post("300", "2026-08-18T00:02:00.000Z", "再生成後の索引"),
    ], catalog);
    assert.equal(searchIndex({ databasePath: database, query: "総理" }).items.length, 0);
    assert.deepEqual(
      searchIndex({ databasePath: database, query: "再生成" }).items.map(({ tweetId }) => tweetId),
      ["300"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search pagination uses the publishedAt and tweetId keyset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-search-page-"));
  try {
    const database = join(directory, "search.sqlite");
    const publishedAt = "2026-08-18T00:00:00.000Z";
    await rebuildSearchIndex(database, [
      post("100", publishedAt, "政府からのお知らせ"),
      post("200", publishedAt, "政府からのお知らせ"),
      post("300", publishedAt, "政府からのお知らせ"),
      post("400", "2026-08-17T23:59:00.000Z", "政府からのお知らせ"),
    ], catalog);

    const first = searchIndex({ databasePath: database, query: "政府", limit: 2 });
    assert.deepEqual(first.items.map(({ tweetId }) => tweetId), ["300", "200"]);
    assert.ok(first.nextCursor);
    const second = searchIndex({
      databasePath: database,
      query: "政府",
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.items.map(({ tweetId }) => tweetId), ["100", "400"]);
    assert.equal(second.nextCursor, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the disposable index rebuilds from verified raw response bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kasumilog-search-raw-"));
  try {
    const rawRoot = join(directory, "raw");
    const database = join(directory, "search.sqlite");
    const body = Buffer.from(JSON.stringify({
      data: {
        timeline: {
          result: {
            rest_id: "900",
            core: {
              user_results: {
                result: {
                  rest_id: "412940784",
                  legacy: { screen_name: "kantei" },
                },
              },
            },
            legacy: {
              created_at: "Mon Aug 18 00:00:00 +0000 2026",
              full_text: "fixture 内閣総理大臣",
            },
          },
        },
      },
    }));
    await storeRawCapture(rawRoot, {
      fetchId: "fetch-1",
      runId: "run-1",
      page: 0,
      attempt: 1,
      listId: "list-1",
      catalogRevision: "a".repeat(64),
      listRevision: "b".repeat(64),
      requestedAt: "2026-08-18T00:00:00.000Z",
      receivedAt: "2026-08-18T00:00:01.000Z",
      request: {
        operation: "ListLatestTweetsTimeline",
        profileName: "account2",
        requestCatalog: {
          source: "https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson",
          revision: "0".repeat(40),
          contentSha256: "c".repeat(64),
          overridesSha256: "f".repeat(64),
        },
        requestTemplateSha256: "d".repeat(64),
        variablesSha256: "e".repeat(64),
      },
      response: { status: 200, headers: { "content-type": "application/json" }, body },
    });

    const result = await rebuildSearchIndexFromRaw({ rawRoot, databasePath: database, catalog });
    assert.deepEqual(result, { fetches: 1, skippedFetches: 0, posts: 1 });
    const projection = new DatabaseSync(database, { readOnly: true });
    const metadata = Object.fromEntries(
      (projection.prepare("select key, value from projection_meta").all() as Array<{
        key: string;
        value: string;
      }>).map(({ key, value }) => [key, value]),
    );
    projection.close();
    assert.equal(metadata.projection_schema, "1");
    assert.equal(metadata.parser_version, "search-index-v1");
    assert.equal(metadata.raw_fetches, "1");
    assert.match(metadata.catalog_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      searchIndex({ databasePath: database, query: "内閣総理" }).items.map(({ tweetId }) => tweetId),
      ["900"],
    );

    await storeRawCapture(rawRoot, {
      fetchId: "fetch-2",
      runId: "run-2",
      page: 0,
      attempt: 1,
      listId: "list-1",
      catalogRevision: "a".repeat(64),
      listRevision: "b".repeat(64),
      requestedAt: "2026-08-18T00:01:00.000Z",
      receivedAt: "2026-08-18T00:01:01.000Z",
      request: {
        operation: "ListLatestTweetsTimeline",
        profileName: "account2",
        requestCatalog: {
          source: "https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson",
          revision: "0".repeat(40),
          contentSha256: "c".repeat(64),
          overridesSha256: "f".repeat(64),
        },
        requestTemplateSha256: "d".repeat(64),
        variablesSha256: "e".repeat(64),
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("not-json"),
      },
    });
    await assert.rejects(
      rebuildSearchIndexFromRaw({ rawRoot, databasePath: database, catalog }),
      /Unable to project raw fetch fetch-2/,
    );
    assert.deepEqual(
      searchIndex({ databasePath: database, query: "内閣総理" }).items.map(({ tweetId }) => tweetId),
      ["900"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
