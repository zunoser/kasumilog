# Private raw archive pipeline

Status: Partially implemented. Raw filesystem storage, request-catalog
provenance, immutable run manifests, a fixture CLI, remote Git readback, a
bounded timeline-only Relay client, a finite pagination/pacing/retry runner,
no-request workflows, and a disposable SQLite/FTS search POC exist. The live
collection workflow is not enabled.

## 1. Goal and ownership

The central system stores only evidence obtained from Twitter Relay:

- complete response body bytes;
- one immutable fetch manifest per observation;
- request-catalog and catalog provenance;
- capture/checkpoint state required to collect safely.

Normalized posts, profiles, observations, SQLite, FTS, and exports are built
locally and are not stored in Git.

```text
private GitHub Actions
  ├─ request construction / pacing / pagination / raw processing
  │
  ├─ ephemeral Tailscale identity
  │          │
  │          ▼
  │   https://tw.home.yutakobayashi.com
  │          │
  │          └─ existing Twitter Relay ──> Twitter
  │
  └─ CAS objects / manifests / collection state
                  │
                  ▼
private Git archive branch
  data/raw/objects + fetches + runs
                  │
                  ▼
each consumer rebuilds local SQLite + FTS
```

## 2. Trust boundaries

### Private GitHub repository

Private means access-controlled, not harmless. A collaborator can clone all
history. The repository therefore has these rules:

- `main` contains code and the catalog;
- dedicated `archive` contains append-only `data/raw` history;
- Actions execute trusted default-branch code only;
- live collection currently has only a `workflow_dispatch` trigger;
- pull-request code never receives the Tailscale identity or write token;
- Tailscale OAuth and archive push secrets live only in the
  `archive-collection-live` Environment;
- third-party actions are pinned to full commit SHAs;
- workflow logs, summaries, and artifacts never contain raw bodies, cursors,
  cookies, or headers.

### Tailscale

Use the kasumilog-specific OAuth client declared by dotnix to create an
ephemeral `tag:ci` node. The generated client ID and secret are copied once to
the `archive-collection-live` Environment; they are not synchronized by another
provider. The tailnet split DNS resolves `tw.home.yutakobayashi.com`, whose
existing Traefik route exposes the Twitter Relay over HTTPS. kasumilog adds no
home process, forwarder, spool, cursor, or archive state.

The current tailnet identity can reach the complete Relay; Tailscale does not
enforce an HTTP path or GraphQL operation allowlist. Therefore only trusted
default-branch workflows receive the Tailscale secrets. The workflow checks its
ref and accepts only `workflow_dispatch`. The current GitHub billing plan does
not provide required reviewers, Environment branch policies, or branch
protection for this private repository, so live collection remains disabled
until a stronger external gate or a supporting plan is available. The OAuth
values must not also exist as repository-level secrets. Pull-request code
receives neither.

### Direct HTTPS Relay access

Request construction, operation selection, profile selection, pagination, pacing, backoff, body
hashing, manifest creation, and Git writes all belong to the Action. The live
client accepts only HTTPS origins and `GET ListLatestTweetsTimeline`; redirects,
write methods, other operations, and request bodies are rejected. This is an
application boundary, not a claim that the network identity itself is
read-only. Every Relay request carries an explicit `x-profile-name`; the live
workflow pins it to `account2`, and the raw fetch manifest records that profile
for provenance. Requests without an explicit profile are not allowed because
the Relay otherwise chooses randomly among logged-in profiles. Twitter-list
mutation uses the separate, explicitly invoked exact-sync CLI; it is not part of
the collection workflow.

## 3. Relay request templates and local version locks

The upstream NDJSON is an immutable base template:

```text
repository: fa0311/twitter_api_safe_relay_skills
branch:     main
path:       skills/twitter-api-relay/requests.ndjson
```

The live workflow stores one reviewed 40-character commit SHA and the expected
file SHA-256. It downloads only that immutable revision:

```text
https://raw.githubusercontent.com/fa0311/
  twitter_api_safe_relay_skills/<commit>/
  skills/twitter-api-relay/requests.ndjson
```

Every non-empty NDJSON line must be a valid request object. Exactly one entry
must exist for each list operation known to the builder. Current X Web client
captures for the operations kasumilog actually uses are reviewed in
`src/relay-overrides.ts`; kasumilog does not wait for the upstream catalog to
refresh them.

An override replaces query ID, features, and static variables as one version
lock. It never merges feature flags with the base. Runtime code then adds only
the list ID, user ID, and page cursor required by that operation. The initial
timeline request omits the base sample cursor; later pages add only the cursor
returned by the preceding verified response.

Each request carries:

- canonical source URL;
- resolved upstream commit;
- SHA-256 of the entire NDJSON;
- SHA-256 of the reviewed local override set;
- SHA-256 of the effective template after applying the override.

The downloaded bytes must match the reviewed SHA-256 before the CLI accepts
them. Updating either lock is a normal kasumilog code review, not a dispatch
input. A pending cursor is scoped to the base catalog and effective-template
hashes. Changing either starts a new head walk with overlap.

## 4. Raw storage contract

### Body object

`storeRawCapture` accepts `Uint8Array`; it does not accept a parsed JSON value.
It calculates SHA-256 over those bytes and stores:

```text
data/raw/objects/sha256/<first-two-hex>/<sha256>.bin
```

`.bin` is intentional: error bodies or future responses need not be JSON. The
hash is independent of interpretation. The current implementation stores the
bytes uncompressed; Git's packfiles may compress them without changing their
object identity.

`captureLevel: relay-response-body-v1` means the exact entity body delivered to
the Action's HTTP client by the HTTPS Relay. Request headers, TLS/TCP framing,
and HTTP transfer framing are not part of this object. The client requests
`Accept-Encoding: identity` and rejects any non-identity content encoding, so
the saved bytes are not a Fetch-decoded representation of compressed bytes.

### Fetch manifest

Every observation has a separate file:

```text
data/raw/fetches/YYYY/MM/DD/<fetch-id>.json
```

Schema version 1 records:

```json
{
  "schemaVersion": 1,
  "fetchId": "...",
  "runId": "...",
  "page": 0,
  "attempt": 1,
  "source": {
    "kind": "list_timeline",
    "listId": "..."
  },
  "request": {
    "operation": "ListLatestTweetsTimeline",
    "requestCatalog": {
      "source": "https://github.com/.../requests.ndjson",
      "revision": "<upstream-commit>",
      "contentSha256": "...",
      "overridesSha256": "..."
    },
    "requestTemplateSha256": "...",
    "variablesSha256": "...",
    "cursorIn": "..."
  },
  "response": {
    "captureLevel": "relay-response-body-v1",
    "status": 200,
    "headers": {
      "content-type": "application/json"
    },
    "excludedHeaderNames": ["set-cookie"],
    "bodySha256": "...",
    "bodyBytes": 123456,
    "storagePath": "objects/sha256/ab/<hash>.bin"
  },
  "catalogRevision": "...",
  "listRevision": "...",
  "requestedAt": "2026-08-18T00:00:00.000Z",
  "receivedAt": "2026-08-18T00:00:01.000Z"
}
```

`cursorIn` is request provenance. `cursorOut` is parsed only after remote
readback verification and remains run-local. The raw body remains authoritative.
Retry/error fetches share the run ID and logical page with an incremented attempt.

### Run manifest

After a walk ends, the Action appends one immutable run record:

```text
data/raw/runs/YYYY/MM/DD/<run-id>.json
```

It records the ordered fetch IDs, final status (`complete`, `partial`, or
`failed`), stop reason, coverage frontier, and the last verified page commit.
This is acquisition provenance, not normalized Twitter data. A run record is
written only after every referenced fetch manifest and body object is already
durable in the archive branch.

### Header handling

Request headers are never accepted by the storage API. The saved response
header allowlist is:

- `content-type`
- `content-encoding`
- `date`
- `etag`
- `last-modified`
- `retry-after`
- `x-rate-limit-limit`
- `x-rate-limit-remaining`
- `x-rate-limit-reset`

Every other response header is omitted and its lowercase name is recorded in
`excludedHeaderNames`. Header values containing authentication material never
enter the manifest, logs, or thrown errors.

## 5. Filesystem durability

Objects and manifests use the same immutable write protocol:

1. create a same-directory temporary file with exclusive mode;
2. write all bytes;
3. fsync and close the file;
4. create the final name atomically without replacing an existing path;
5. fsync the parent directory;
6. remove the temporary name.

The body object is committed before its fetch manifest. Therefore:

- an orphan body object is recoverable and allowed;
- a committed fetch manifest whose body is absent is forbidden;
- an existing CAS path is reused only after byte verification;
- the same fetch ID with different manifest bytes fails;
- the same body seen in 100 fetches creates one object and 100 manifests.

Startup reconciliation reports orphan objects and incomplete staging state; it
does not automatically delete evidence.

## 6. Git archive branch

The archive writer accepts a worktree on the dedicated `archive` branch and
passes `data/raw` as the storage root. For each page it performs:

```text
call https://tw.home.yutakobayashi.com/i/api/... through Tailscale
  -> receive body in the Action
  -> write/verify CAS object
  -> write/verify fetch manifests
  -> verify every manifest reference
  -> git add data/raw
  -> create a page/run-scoped commit
  -> push archive branch without force
  -> clone the remote branch into a separate clean directory
  -> verify commit reachability, manifest, body hash, and body bytes
  -> derive cursor and permit the next page
```

Workflow `concurrency` permits one archive writer. The pushed commit records
run ID, page count, first/last received time, and catalog/list revisions in its
message without embedding body content.

No normalized files are staged. `.gitignore` excludes:

- `data/normalized`
- `data/exports`
- `state`
- SQLite, WAL, and SHM files

Raw data is not stored in GitHub Actions artifacts, caches, or Releases. The
private Git history is the central durable copy and must have an independent
repository backup. The home server retains no archive copy.

The implemented `collect-fixture` command exercises this sequence against a
caller-supplied Git remote without contacting Twitter. The smoke workflow uses
an ephemeral bare remote and never writes the repository's real archive branch.

## 7. Pagination and completeness

Each walk records every response page before interpreting it. It tracks tweet
IDs and every Bottom cursor, detects repeated/cyclic cursors, and ends with one
state:

- `complete`: reached a known overlap region or explicit terminal cursor;
- `partial`: retained useful pages without proving the collection boundary;
- `failed`: retained no page that advances useful capture state.

`complete` describes the observed API pagination protocol, not all posts that
ever existed on Twitter.

The coverage frontier consists of a published-time boundary plus a bounded set
of known tweet IDs. It is not one cursor, text hash, or one tweet ID. With no previous
frontier and no `bootstrapFrom`, the first live run stores one useful head page
and stops as `initial_seed`. Historical collection occurs only in a manually
requested collector run with an explicit `bootstrapFrom`. The initial live CLI
and workflow intentionally do not expose historical backfill; it remains a
future separately reviewed interface. Collector-level backfill remains bounded
by page, request, item, and wall-clock limits; reaching a limit first is `partial`.

Collection state is reconstructed from immutable fetch manifests and run
manifests on
the archive branch rather than a mutable home checkpoint:

- `pageCursor`: usable only inside the current run and only after that page's
  remote Git commit is read back and verified;
- `captureCoverageFrontier`: recorded after a protocol-complete run;
- `gitArchiveFrontier`: the latest verified remote archive commit.

If the runner stops after receiving a response but before pushing it, no
checkpoint advances. A later run safely refetches the page. At-least-once
collection and CAS deduplication make this acceptable.

The POC does not persist an upstream cursor across runs. Every run starts at
the timeline head. Later runs stop after seeing a known frontier tweet ID or a
normal timeline entry strictly older than the frontier timestamp; a terminal
cursor also proves completion. Equal text never proves overlap. This deliberately
trades duplicate reads for a smaller and cursor-expiry-safe first implementation.
An old pinned entry does not prove a historical boundary; bootstrap comparison
uses the chronological floor at the end of normal tweet entries.

## 8. Pacing and retry

The Action is authoritative for collection control:

- before any Relay request, verify the archive worktree branch, remote HEAD,
  staged state, and that `data/raw` has no uncommitted recovery residue;

- one Relay request in flight globally;
- 30 seconds plus zero to 15 seconds jitter after every response;
- workflow concurrency permits only one collector;
- live collection is manual-only, reads secrets from the
  `archive-collection-live` Environment, and has no schedule or pull-request
  trigger;
- trusted source and the dedicated `archive` branch use separate checkouts;
- the collection job grants its built-in `GITHUB_TOKEN` `contents: write` for
  append-only archive pushes. It is exposed as `GH_TOKEN` only to Git setup and
  the collector step; the job-scoped permission is documented inline;
- `Retry-After` delta-seconds and HTTP-date support;
- rate-limit reset honored when present;
- otherwise bounded exponential backoff with full jitter;
- retry only network/timeout failures and 408, 429, 500, 502, 503, 504;
- no immediate retry for decode errors or other 4xx responses;
- bounded page, attempt, and wall-clock budgets.

Defaults are three timeline pages, eight total requests, 200 unique posts, ten
minutes, and three attempts per logical page. Retry without a server deadline
uses capped exponential full jitter with a 60-second base and 15-minute cap.
`Retry-After` accepts both delay-seconds and HTTP-date. A zero remaining count
honors `x-rate-limit-reset` even after a successful response.

Within a run, waits are held in memory. Across runs, the Action derives the
minimum next request time from the most recent committed fetch manifest's
receive time and rate-limit headers. Every fresh run also applies the normal
minimum spacing before its first Relay call. No pacing state is stored at home.

## 9. Twitter response changes

Raw storage occurs before schema-dependent processing. A changed response can
therefore be committed even if the current parser cannot normalize it.

Each fetch identifies its operation, upstream catalog commit, selected-template
hash, and collector/parser version. The parser also calculates a JSON-shape
fingerprint after the body is durable.

If required fields or cursor structure change:

1. keep and commit the raw body and fetch manifest from the Action worktree;
2. mark the run `partial` with `decode_error`;
3. do not advance capture coverage;
4. alert with hashes and shape diff, never the body;
5. build a new parser version using the saved raw fixture;
6. rebuild local projections from the committed raw objects.

There is no fallback chain in collection. A local rebuild selects one explicit
parser version and produces a disposable database.

## 10. Local projection

The first local projection is intentionally a disposable POC. It enumerates
fetch manifests, verifies each referenced raw body hash, parses valid timeline
bodies, and creates a new SQLite database beside the archive. No migration or
incremental updater exists; rerun the full rebuild after raw or parser changes.
Only `ListLatestTweetsTimeline` fetches are inputs. A non-success HTTP response
is counted and skipped; an undecodable successful response fails the rebuild
without replacing the previous database.

The database has one canonical `posts` table and one standalone `posts_fts`
table with `tokenize='trigram'`. Both rows are inserted in the same transaction.
Search terms of three or more Unicode characters use FTS for candidate
selection and `instr()` for literal confirmation. One- and two-character terms
use a documented `instr()` scan because trigram cannot match them.

Results use chronological keyset pagination on
`(published_at DESC, tweet_id DESC)`, fetch `limit + 1`, and return an opaque
cursor containing the last pair. `OFFSET`, relevance pagination, adaptive join
plans, schema migrations, and committed SQLite files are out of scope for the
POC.

`projection_meta` records the projection schema, parser version, catalog hash,
target fetch count, and skipped non-success count. Reproduction therefore means
the raw archive plus the selected code and catalog revision, not raw bytes alone.

## 11. Catalog and Twitter list differences

Two revisions remain separate:

- `listRevision`: hash of active Twitter IDs used for desired membership;
- `catalogRevision`: hash of complete classification dimensions.

Handle changes retain the same Twitter numeric ID. Retiring an account changes
its status to `inactive`; history is not deleted. A complete `ListMembers`
snapshot is required before any removal plan can be created.

Scheduled collection may report a difference but cannot apply it. Future list
application remains a separate manual workflow and verifies a fresh complete
snapshot after every write.

## 12. Verification requirements

Implementation is not complete until tests prove:

- invalid UTF-8 and non-JSON body bytes round-trip exactly;
- identical bodies deduplicate while fetch manifests do not;
- unsafe response header values never reach disk;
- an existing immutable path cannot be replaced;
- a corrupted CAS object fails read verification;
- no fetch manifest is committed before its body object;
- repeated/cyclic cursors end `partial` without advancing coverage;
- a fresh Action run reconstructs its frontier and minimum next-request time
  from committed archive manifests;
- incomplete list snapshots cannot produce removals;
- Git push verification precedes use of a page cursor for the next request;
- the plan workflow cannot execute a Relay request;
- the live Relay client rejects non-timeline operations and write methods;
- the archive workflow passes `actionlint`, `pinact`, `ghalint`, and `zizmor`.

## 13. Remaining implementation order

1. Configure an independent backup for the real private `archive` branch.
2. Add a live-execution gate outside the unsupported private-repository
   Environment and branch-protection features, or move to a supporting plan.
3. Manually run the implemented workflow against one head page,
   then inspect committed fetch/run manifests before adding any schedule.
4. Exercise the local FTS POC against the first real raw archive
   and optimize only if measurements require it.
Twitter-list reconciliation is implemented separately and has been exercised
against the private `account2` list. No real archive-branch commit, workflow
dispatch, or timeline collection has been performed yet.

## References

- [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action)
- [Tailscale Grants](https://tailscale.com/docs/features/access-control/grants)
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [birdclaw](https://github.com/steipete/birdclaw)
- [birdclaw sync plan](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/sync-plan.ts#L78-L164)
- [RFC 9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
- [AWS exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Google Cloud retry strategy](https://cloud.google.com/storage/docs/retry-strategy)
- [birdclaw FTS schema](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/db.ts#L426-L434)
- [birdclaw keyset query](https://github.com/steipete/birdclaw/blob/a0dda9e035b1943884671bfdfdaac59e6d2f761b/src/lib/timeline-read-model.ts#L709-L725)
- [SQLite FTS5 trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
- [bird](https://git.yutakobayashi.com/yuta/bird)
- [Relay requests.ndjson](https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson)
