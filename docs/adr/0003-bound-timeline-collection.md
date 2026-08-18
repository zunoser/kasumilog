# ADR 0003: Bound and pace timeline collection

- Status: Accepted
- Date: 2026-08-18

## Context

`ListLatestTweetsTimeline` is a private GraphQL read endpoint with no stable
public rate-limit contract. An unbounded first run could walk years of history,
generate avoidable load, and increase account restriction risk. Cursor values
can expire and must not become the archive's durable frontier.

## Decision

- Run one request at a time. Wait 30 seconds plus zero to 15 seconds jitter
  after every response, including retryable errors.
- On the first run, collect only one useful head page by default. Historical
  collection requires an explicit `bootstrapFrom` in a manual run. The initial
  live CLI/workflow does not expose this historical mode.
- Bound every run to eight timeline pages, 12 requests, 600 unique posts,
  ten minutes, and three attempts per logical page by default.
- Retry network/timeouts and HTTP 408, 429, 500, 502, 503, and 504 only.
  Respect `Retry-After` delay-seconds or HTTP-date and rate-limit reset. Without
  those fields, use capped exponential full jitter with a 60-second base.
- Persist every HTTP response as raw, push it, and verify it from a clean clone
  before parsing JSON, using its cursor, or making a retry decision. Network
  failures have no response body to persist.
- Keep upstream cursors inside one run. Start each run at the head and stop only
  after proving overlap with the prior frontier, reaching an explicit bootstrap
  boundary, or reaching the terminal cursor. Overlap is proven by seeing a known
  frontier tweet ID or passing strictly below its timestamp in normal timeline
  entries. The timestamp condition preserves liveness if a frontier tweet was
  deleted or hidden.
- Never use equal post text as a stop condition. Distinct posts, reposts, edits,
  and recurring government notices may have identical text.
- Mark bounded or retry-exhausted walks `partial`/`failed`; only `complete` runs
  may advance the coverage frontier.

## Consequences

- Initial activation has one Relay request and cannot backfill all history by
  accident.
- Historical backfill remains disabled in the live interface until the one-page
  path is reviewed; collector-level support is slow, finite, and operator-controlled.
- A partial bootstrap restarts from the head if repeated; the operator should
  move `bootstrapFrom` forward or explicitly change a finite limit rather than
  scheduling repeated partial backfills.
- Duplicate reads are accepted because raw CAS and tweet IDs deduplicate, while
  cursor expiry cannot strand durable state.
- The response containing overlap evidence is stored in full before stopping,
  retaining same-second entries delivered in that response.

## Adoption and Exceptions

- Fake-clock tests verify actual request start times, Retry-After formats,
  rate-limit reset, retry classification, finite limits, cursor repetition,
  frontier overlap, and persist-before-next ordering.
- After one initial and one incremental manual run were verified, the live
  workflow runs hourly at minute 17 and remains manually dispatchable. Both
  paths retain the same finite limits, pacing, default-branch guard, and static
  concurrency group.
- Any increase to limits or decrease to pacing requires an ADR update and a
  review of recent raw rate-limit manifests.
- The 8-page/600-post ceiling was adopted after the first incremental run to
  tolerate hourly bursts. Frontier early return keeps normal runs at one page;
  pacing and the ten-minute wall-clock limit are unchanged.

## References

- [Birdclaw finite sync plan](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/sync-plan.ts#L78-L164)
- [RFC 9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
- [AWS exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Google Cloud retry strategy](https://cloud.google.com/storage/docs/retry-strategy)
