import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { extractArchiveBatch, mergeArchive, type ArchivedPost } from "./archive.ts";
import type { Catalog } from "./model.ts";
import { readRawCapture, type RawFetchManifest } from "./raw.ts";
import { createCatalogRevision } from "./sync.ts";

export interface SearchIndexBuildResult {
  readonly fetches: number;
  readonly skippedFetches: number;
  readonly posts: number;
}

export interface SearchResult {
  readonly tweetId: string;
  readonly publishedAt: string;
  readonly text: string;
  readonly publisherTwitterId: string;
  readonly handle?: string;
  readonly organization?: string;
  readonly person?: string;
  readonly role?: string;
  readonly government?: string;
  readonly domain?: string;
}

export interface SearchPage {
  readonly items: readonly SearchResult[];
  readonly nextCursor?: string;
}

interface SearchCursor {
  readonly publishedAt: string;
  readonly tweetId: string;
}

const SCHEMA = `
  pragma journal_mode = delete;
  pragma synchronous = normal;

  create table projection_meta (
    key text primary key,
    value text not null
  );

  create table posts (
    tweet_id text primary key,
    published_at text not null,
    text text not null,
    search_text text not null,
    publisher_twitter_id text not null,
    handle text,
    organization text,
    person text,
    role text,
    government text,
    domain text
  );

  create index posts_published_tweet
    on posts(published_at desc, tweet_id desc);

  create virtual table posts_fts using fts5(
    tweet_id unindexed,
    search_text,
    tokenize='trigram'
  );
`;

function searchableText(post: ArchivedPost, catalog: Catalog): string {
  const organization = catalog.organizations.find(
    ({ id }) => id === post.metadata?.organization,
  );
  const person = catalog.persons.find(({ id }) => id === post.metadata?.person);
  const role = catalog.roles.find(({ id }) => id === post.metadata?.role);
  return [
    post.text,
    post.publisher.handle,
    organization?.name,
    person?.name,
    role?.name,
    post.metadata?.organization,
    post.metadata?.person,
    post.metadata?.role,
    post.metadata?.government,
    post.metadata?.domain,
  ].filter((value): value is string => Boolean(value)).join("\n").normalize("NFKC");
}

function populateDatabase(
  databasePath: string,
  posts: readonly ArchivedPost[],
  catalog: Catalog,
  metadata: Readonly<Record<string, string>>,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(SCHEMA);
    const insertPost = database.prepare(`
      insert into posts (
        tweet_id, published_at, text, search_text, publisher_twitter_id,
        handle, organization, person, role, government, domain
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = database.prepare(
      "insert into posts_fts (tweet_id, search_text) values (?, ?)",
    );
    const insertMetadata = database.prepare(
      "insert into projection_meta (key, value) values (?, ?)",
    );
    database.exec("begin");
    try {
      for (const post of posts) {
        const searchText = searchableText(post, catalog);
        insertPost.run(
          post.tweetId,
          post.publishedAt,
          post.text,
          searchText,
          post.publisher.twitterId,
          post.publisher.handle ?? null,
          post.metadata?.organization ?? null,
          post.metadata?.person ?? null,
          post.metadata?.role ?? null,
          post.metadata?.government ?? null,
          post.metadata?.domain ?? null,
        );
        insertFts.run(post.tweetId, searchText);
      }
      for (const [key, value] of Object.entries(metadata).sort()) {
        insertMetadata.run(key, value);
      }
      database.exec("commit");
    } catch (error) {
      database.exec("rollback");
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function rebuildSearchIndex(
  databasePath: string,
  posts: readonly ArchivedPost[],
  catalog: Catalog,
): Promise<void> {
  const target = resolve(databasePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  populateDatabase(temporary, posts, catalog, {
    projection_schema: "1",
    parser_version: "search-index-v1",
    catalog_sha256: createCatalogRevision(catalog),
    raw_fetches: "0",
    skipped_fetches: "0",
  });
  await rename(temporary, target);
}

async function jsonFiles(root: string): Promise<readonly string[]> {
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
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

export async function rebuildSearchIndexFromRaw(options: {
  readonly rawRoot: string;
  readonly databasePath: string;
  readonly catalog: Catalog;
}): Promise<SearchIndexBuildResult> {
  const rawRoot = resolve(options.rawRoot);
  const manifests = await Promise.all(
    (await jsonFiles(join(rawRoot, "fetches"))).map(async (path) =>
      JSON.parse(await readFile(path, "utf8")) as RawFetchManifest
    ),
  );
  manifests.sort((left, right) =>
    left.receivedAt === right.receivedAt
      ? left.fetchId.localeCompare(right.fetchId)
      : left.receivedAt.localeCompare(right.receivedAt)
  );
  const timelineManifests = manifests.filter(
    ({ request }) => request.operation === "ListLatestTweetsTimeline",
  );

  let posts: readonly ArchivedPost[] = [];
  let skippedFetches = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const manifest of timelineManifests) {
    const body = await readRawCapture(rawRoot, manifest);
    if (manifest.response.status < 200 || manifest.response.status >= 300) {
      skippedFetches += 1;
      continue;
    }
    try {
      const payload = JSON.parse(decoder.decode(body));
      if (
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { errors?: unknown }).errors) &&
        (payload as { errors: readonly unknown[] }).errors.length > 0
      ) {
        throw new Error("GraphQL response contains errors");
      }
      const batch = extractArchiveBatch(
        payload,
        options.catalog,
        manifest.source.listId,
        manifest.receivedAt,
      );
      posts = mergeArchive(posts, batch.posts);
    } catch (error) {
      throw new Error(`Unable to project raw fetch ${manifest.fetchId}`, { cause: error });
    }
  }

  const target = resolve(options.databasePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  populateDatabase(temporary, posts, options.catalog, {
    projection_schema: "1",
    parser_version: "search-index-v1",
    catalog_sha256: createCatalogRevision(options.catalog),
    raw_fetches: String(timelineManifests.length),
    skipped_fetches: String(skippedFetches),
  });
  await rename(temporary, target);
  return { fetches: timelineManifests.length, skippedFetches, posts: posts.length };
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SearchCursor {
  let cursor: Partial<SearchCursor>;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid search cursor");
  }
  if (
    typeof cursor.publishedAt !== "string" ||
    Number.isNaN(Date.parse(cursor.publishedAt)) ||
    typeof cursor.tweetId !== "string" ||
    !cursor.tweetId
  ) {
    throw new Error("Invalid search cursor");
  }
  return cursor as SearchCursor;
}

function searchTerms(query: string): readonly string[] {
  return query.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
}

export function searchIndex(options: {
  readonly databasePath: string;
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
}): SearchPage {
  const terms = searchTerms(options.query);
  if (terms.length === 0) throw new Error("Search query must not be empty");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Search limit must be between 1 and 100");
  }
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const usesFts = terms.every((term) => [...term].length >= 3);
  const params: Array<string | number> = [];
  let from = "posts p";
  const where: string[] = [];
  if (usesFts) {
    from += " join posts_fts f on f.tweet_id = p.tweet_id";
    where.push("posts_fts match ?");
    params.push(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" "));
  }
  for (const term of terms) {
    where.push("instr(p.search_text, ?) > 0");
    params.push(term);
  }
  if (cursor) {
    where.push("(p.published_at < ? or (p.published_at = ? and p.tweet_id < ?))");
    params.push(cursor.publishedAt, cursor.publishedAt, cursor.tweetId);
  }
  params.push(limit + 1);

  const database = new DatabaseSync(resolve(options.databasePath), { readOnly: true });
  try {
    const rows = database.prepare(`
      select p.tweet_id, p.published_at, p.text, p.publisher_twitter_id,
             p.handle, p.organization, p.person, p.role, p.government, p.domain
      from ${from}
      where ${where.join(" and ")}
      order by p.published_at desc, p.tweet_id desc
      limit ?
    `).all(...params) as Array<Record<string, string | null>>;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): SearchResult => ({
      tweetId: String(row.tweet_id),
      publishedAt: String(row.published_at),
      text: String(row.text),
      publisherTwitterId: String(row.publisher_twitter_id),
      ...(row.handle ? { handle: row.handle } : {}),
      ...(row.organization ? { organization: row.organization } : {}),
      ...(row.person ? { person: row.person } : {}),
      ...(row.role ? { role: row.role } : {}),
      ...(row.government ? { government: row.government } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
    }));
    const last = hasMore ? items.at(-1) : undefined;
    return {
      items,
      ...(last
        ? { nextCursor: encodeCursor({ publishedAt: last.publishedAt, tweetId: last.tweetId }) }
        : {}),
    };
  } finally {
    database.close();
  }
}
