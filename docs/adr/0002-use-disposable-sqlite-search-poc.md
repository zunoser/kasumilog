# ADR 0002: Use a disposable SQLite search POC

- Status: Accepted
- Date: 2026-08-18

## Context

Raw Twitter Relay response bodies in Git are authoritative. SQLite and FTS are
local projections and can be regenerated. The first search implementation must
prove useful Japanese substring search and stable pagination without creating
a second migration or persistence system.

Birdclaw keeps canonical tweet and FTS rows in one transaction and pages by
`(created_at, id)`. Its current FTS table uses SQLite's default tokenizer, not
trigram. Kasumilog needs Japanese substring search, so trigram is a separate
choice based on SQLite FTS5.

## Decision

- Use the Node 22 built-in `node:sqlite`; add no SQLite package.
- Rebuild the entire local database from verified raw bodies. Do not implement
  schema migrations or incremental updates in the POC.
- Store canonical rows in `posts` and search rows in standalone `posts_fts`
  with `tokenize='trigram'`; write both in one transaction.
- Use FTS for terms of at least three Unicode characters, followed by literal
  `instr()` confirmation. Use an `instr()` scan for shorter terms.
- Sort by `published_at DESC, tweet_id DESC` and paginate with the last pair.
  Fetch `limit + 1`; do not use `OFFSET` or relevance pagination.
- Keep SQLite and all normalized rows out of Git.
- Record schema/parser identity, catalog SHA-256, and raw fetch counts in a
  minimal `projection_meta` table. Fail rebuild on an undecodable successful
  timeline response instead of publishing a partial database.

## Consequences

- The POC is small and can be deleted and rebuilt after parser/schema changes.
- Japanese queries such as `内閣総理` use trigram; short terms such as `総理`
  remain correct but may scan the canonical table.
- Rebuild time grows with the raw archive. Optimization is deferred until real
  measurements show a problem.
- `node:sqlite` is experimental in Node 22. This is acceptable for a disposable
  local projection; an API change requires code adjustment and rebuild, not a
  data migration.

## Adoption and Exceptions

- Tests cover trigram search, two-character fallback, raw rebuild, and multiple
  rows sharing one timestamp across keyset pages.
- New search complexity requires a measured failing workload. Adaptive query
  plans, rank cursors, triggers, and incremental migrations are not accepted
  preemptively.

## References

- [Birdclaw FTS schema](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/db.ts#L426-L434)
- [Birdclaw canonical/FTS transaction](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/tweet-repository.ts#L45-L57)
- [Birdclaw keyset pagination](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/timeline-read-model.ts#L709-L725)
- [SQLite FTS5 trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
