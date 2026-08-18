import { createPostMetadata, type Catalog, type PostMetadata } from "./model.ts";

export interface ArchivedPublisher {
  readonly twitterId: string;
  readonly handle?: string;
  readonly catalogAccountId?: string;
}

export interface EmbeddedPostReference {
  readonly tweetId: string;
  readonly publisherTwitterId?: string;
  readonly handle?: string;
  readonly publishedAt?: string;
  readonly text?: string;
}

export interface ArchivedPost {
  readonly schemaVersion: 1;
  readonly listId: string;
  readonly tweetId: string;
  readonly publisher: ArchivedPublisher;
  readonly repostOf?: EmbeddedPostReference;
  readonly quoteOf?: EmbeddedPostReference;
  readonly text: string;
  readonly publishedAt: string;
  readonly firstCollectedAt: string;
  readonly lastCollectedAt: string;
  readonly metadata?: PostMetadata;
}

export interface ArchiveBatch {
  readonly posts: readonly ArchivedPost[];
  readonly nextCursor?: string;
  readonly unknownAuthorIds: readonly string[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nestedObject(root: JsonObject | undefined, ...path: string[]): JsonObject | undefined {
  let current = root;
  for (const part of path) current = asObject(current?.[part]);
  return current;
}

function visitObjects(
  value: unknown,
  visitor: (object: JsonObject, embedded: boolean) => void,
  embedded = false,
): void {
  const object = asObject(value);
  if (object) {
    visitor(object, embedded);
    for (const [key, child] of Object.entries(object)) {
      visitObjects(
        child,
        visitor,
        embedded || key === "retweeted_status_result" || key === "quoted_status_result",
      );
    }
  } else if (Array.isArray(value)) {
    for (const child of value) visitObjects(child, visitor, embedded);
  }
}

function userInfo(tweet: JsonObject): { twitterId?: string; handle?: string } {
  const user = nestedObject(tweet, "core", "user_results", "result");
  const legacy = asObject(user?.legacy);
  return {
    twitterId: typeof user?.rest_id === "string" ? user.rest_id : undefined,
    handle: typeof legacy?.screen_name === "string" ? legacy.screen_name : undefined,
  };
}

function embeddedReference(tweet: JsonObject | undefined): EmbeddedPostReference | undefined {
  if (!tweet || typeof tweet.rest_id !== "string") return undefined;
  const legacy = asObject(tweet.legacy);
  const user = userInfo(tweet);
  const publishedDate =
    typeof legacy?.created_at === "string" ? new Date(legacy.created_at) : undefined;
  return {
    tweetId: tweet.rest_id,
    publisherTwitterId: user.twitterId,
    handle: user.handle,
    publishedAt:
      publishedDate && !Number.isNaN(publishedDate.valueOf())
        ? publishedDate.toISOString()
        : undefined,
    text: typeof legacy?.full_text === "string" ? legacy.full_text : undefined,
  };
}

export function extractArchiveBatch(
  payload: unknown,
  catalog: Catalog,
  listId: string,
  collectedAt: string,
): ArchiveBatch {
  if (Number.isNaN(Date.parse(collectedAt))) {
    throw new Error(`Invalid collectedAt: ${collectedAt}`);
  }

  const posts = new Map<string, ArchivedPost>();
  const unknownAuthorIds = new Set<string>();
  let nextCursor: string | undefined;

  visitObjects(payload, (object, embedded) => {
    if (
      object.cursorType === "Bottom" &&
      typeof object.value === "string" &&
      !nextCursor
    ) {
      nextCursor = object.value;
    }
    if (embedded) return;

    const legacy = asObject(object.legacy);
    if (
      typeof object.rest_id !== "string" ||
      typeof legacy?.full_text !== "string" ||
      typeof legacy.created_at !== "string"
    ) {
      return;
    }

    const user = userInfo(object);
    if (!user.twitterId) return;
    const publishedDate = new Date(legacy.created_at);
    if (Number.isNaN(publishedDate.valueOf())) return;
    const publishedAt = publishedDate.toISOString();
    const account = catalog.accounts.find(({ twitterId }) => twitterId === user.twitterId);
    if (!account) unknownAuthorIds.add(user.twitterId);

    const repost = embeddedReference(
      nestedObject(legacy, "retweeted_status_result", "result"),
    );
    const quote = embeddedReference(
      nestedObject(object, "quoted_status_result", "result"),
    );
    const originalTwitterId = repost?.publisherTwitterId ?? quote?.publisherTwitterId;
    const originalPublisher = originalTwitterId
      ? catalog.accounts.find(({ twitterId }) => twitterId === originalTwitterId)?.id
      : undefined;
    const metadata = account
      ? createPostMetadata(catalog, {
          publisher: account.id,
          publishedAt,
          originalPublisher,
        })
      : undefined;

    posts.set(object.rest_id, {
      schemaVersion: 1,
      listId,
      tweetId: object.rest_id,
      publisher: {
        twitterId: user.twitterId,
        ...(user.handle ? { handle: user.handle } : {}),
        ...(account ? { catalogAccountId: account.id } : {}),
      },
      ...(repost ? { repostOf: repost } : {}),
      ...(quote ? { quoteOf: quote } : {}),
      text: legacy.full_text,
      publishedAt,
      firstCollectedAt: collectedAt,
      lastCollectedAt: collectedAt,
      ...(metadata
        ? { metadata: JSON.parse(JSON.stringify(metadata)) as PostMetadata }
        : {}),
    });
  });

  return {
    posts: [...posts.values()].sort((left, right) =>
      left.publishedAt.localeCompare(right.publishedAt),
    ),
    nextCursor,
    unknownAuthorIds: [...unknownAuthorIds].sort(),
  };
}

export function mergeArchive(
  existing: readonly ArchivedPost[],
  incoming: readonly ArchivedPost[],
): readonly ArchivedPost[] {
  const posts = new Map(existing.map((post) => [post.tweetId, post]));
  for (const post of incoming) {
    const previous = posts.get(post.tweetId);
    posts.set(post.tweetId, {
      ...post,
      firstCollectedAt: previous?.firstCollectedAt ?? post.firstCollectedAt,
      lastCollectedAt:
        previous && previous.lastCollectedAt > post.lastCollectedAt
          ? previous.lastCollectedAt
          : post.lastCollectedAt,
    });
  }
  return [...posts.values()].sort((left, right) =>
    left.publishedAt === right.publishedAt
      ? left.tweetId.localeCompare(right.tweetId)
      : left.publishedAt.localeCompare(right.publishedAt),
  );
}

export function serializeArchive(posts: readonly ArchivedPost[]): string {
  return posts.length ? `${posts.map((post) => JSON.stringify(post)).join("\n")}\n` : "";
}

export function parseArchive(serialized: string): readonly ArchivedPost[] {
  return serialized
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ArchivedPost);
}
