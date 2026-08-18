# ADR 0001: Commit immutable raw responses and rebuild projections locally

- Status: Accepted
- Date: 2026-08-18

## Context

kasumilog monitors a Twitter list of public-sector accounts. Twitter response
shapes, Relay query IDs, account membership, office holders, and classification
rules will change over time. A normalized-only archive cannot recover fields
discarded by an older parser.

The repository and its Actions are private. The user has chosen to preserve
complete Twitter Relay response bodies in Git. Normalized posts, SQLite, FTS,
and exports must not be committed; each consumer rebuilds them locally.

## Decision

### Exact Relay response bodies are authoritative

The body is accepted as `Uint8Array`, hashed before interpretation, and stored
byte-for-byte at:

```text
data/raw/objects/sha256/ab/<body-sha256>.bin
```

The preservation boundary is explicit:
`captureLevel: relay-response-body-v1` means the exact body bytes returned by
the HTTPS Relay to the Action's HTTP client, not an assertion that TLS/TCP
framing or every Twitter wire header was preserved. The Action requests
`Accept-Encoding: identity` and rejects non-identity content encodings before
capture, avoiding ambiguity from Fetch's transparent decompression.

Identical body bytes share one content-addressed object. Each fetch remains a
separate observation and has its own immutable manifest.

### Fetch manifests contain provenance, not credentials

One immutable JSON file is stored per fetch:

```text
data/raw/fetches/YYYY/MM/DD/<fetch-id>.json
```

It records the run/page/list, request operation, upstream `requests.ndjson`
source and commit, complete-catalog and selected-template hashes, sanitized
variables hash, requested/received times, HTTP status, safe response headers,
body hash/size/path, catalog revision, list revision, and optional cursors.

Request headers are never stored. Response headers use a small allowlist.
Cookies, authorization, CSRF, tokens, proxy headers, and Relay-internal headers
are excluded even in the private repository.

One immutable run manifest is also committed after a walk ends. It contains
only acquisition provenance: ordered fetch IDs, completion state, stop reason,
coverage frontier, and the last verified page commit. It is not normalized
Twitter data and allows a fresh Action runner to reconstruct collection state
without a home-server checkpoint.

The first implementation proves this boundary with a fixture CLI. Each page is
non-force-pushed, then cloned into a separate clean directory and verified
byte-for-byte before its commit becomes eligible for a run manifest. The smoke
workflow uses only an ephemeral bare remote and does not modify the real
archive branch.

### The upstream NDJSON is a base template

The upstream base request catalog is:

[`fa0311/twitter_api_safe_relay_skills/skills/twitter-api-relay/requests.ndjson`](https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson)

The live workflow pins a reviewed commit SHA and expected full-file SHA-256,
then fetches only that immutable revision. Current X Web client query IDs,
features, and static variables for the operations kasumilog uses are maintained
as one reviewed local override set. This avoids waiting for an upstream catalog
refresh while retaining the upstream request shape as a base. The request keeps
the base source URL, commit SHA, full-file SHA-256, local override SHA-256, and
the effective-template SHA-256.

### Raw data alone is committed

The private repository uses a dedicated `archive` branch for `data/raw`.
Collection commits append-only objects and manifests to that branch. The
collector forbids replacement of an existing fetch ID or CAS object. Force
pushes and branch deletion remain operationally forbidden but cannot be
enforced by the current GitHub billing plan.

The following are local disposable projections and are ignored by Git:

- normalized post/profile/observation tables;
- normalized NDJSON and portable exports;
- SQLite databases, WAL, and FTS tables;
- snippets, aggregates, and read-model caches.

The existing `ArchivedPost` NDJSON is a local export/prototype, not an archive
format.

### Durability precedes checkpoints

Collection is at-least-once. The durable order is:

```text
Action receives Relay body
  -> raw CAS object and fetch manifest written in archive worktree
  -> Git commit created and pushed
  -> pushed commit read back and hashes verified
  -> page cursor becomes eligible for the next request
```

Collection state is reconstructed from committed raw manifests and run records:

- page-resume cursor: advances after that page's remote Git commit is verified;
- capture-coverage frontier: advances after a protocol-complete timeline walk;
- Git-archive frontier: advances only after the remote Git commit is verified.

A runner failure before push advances nothing and may cause a safe refetch.
A partial run cannot prove deletion or list-member removal.

### Actions access the existing Relay directly over Tailscale HTTPS

The private workflow uses a kasumilog-specific Tailscale OAuth client declared
by dotnix and creates an ephemeral `tag:ci` node. Existing split DNS and Traefik routing expose
`https://tw.home.yutakobayashi.com`; kasumilog calls it directly and adds no
home forwarder, archive files, spool, cursor, checkpoint, or Git credential.

The Action owns request construction, the single-worker constraint, 30-second
request spacing plus jitter, backoff, pagination, raw processing, and Git writes.
Its collection client accepts only HTTPS and `GET ListLatestTweetsTimeline`.
It also requires an explicit Relay profile and records that profile in each
fetch manifest; the live workflow currently pins `account2`.
After a runner restart, it reconstructs its frontier and minimum safe request
time from committed archive manifests.

The current tailnet identity can technically reach the full Relay, including
routes outside the collector allowlist. That trust is accepted for this direct
topology: Tailscale secrets are available only to trusted default-branch
workflows through an `archive-collection-live` GitHub Environment. The current
private-repository billing plan does not provide Environment branch policies,
required reviewers, or branch protection, so `workflow_dispatch` and the
default-branch ref guard are the available in-repository checks and live
collection remains disabled pending a stronger gate. The OAuth values are not
duplicated as repository-level secrets and are never available to pull-request
code. Twitter mutations remain absent from live collection code and use a
separate, explicitly invoked exact-sync CLI.

## Consequences

- Parser bugs and schema changes can be repaired without refetching Twitter.
- The raw response may contain more data than the current normalizer uses; Git
  repository access must remain restricted to intended collaborators.
- Git history grows monotonically. This is accepted for the initial archive;
  repository size is monitored as an operational metric.
- Normalized data and FTS are reproducible but intentionally absent from Git.
- Git is the first durable archive boundary, so a response received immediately
  before runner failure can be refetched but is not retained by the home server.
- The network identity is not operation-scoped; repository and workflow
  protection are part of the security boundary.
- Removing a collaborator's access does not revoke copies they already cloned.
- Making the repository public is a new architectural and policy decision; it
  is not a configuration toggle.

## Rejected alternatives

### Commit normalized NDJSON

It duplicates a rebuildable projection, creates parser-version churn, and can
be regenerated from raw.

### Commit SQLite or FTS

Binary diffs are poor Git objects, WAL state is unsafe to copy, and consumers
may require different SQLite/FTS versions.

### Store only normalized posts

It loses unknown fields and makes future parser fixes unable to reproduce the
original response.

### Add a dedicated capture forwarder

It could enforce a smaller network-facing API, but duplicates an already
available HTTPS route and adds another home component to deploy and maintain.
The selected design keeps the topology simple and enforces the timeline-only
contract in trusted Action code.

### Store a raw spool and checkpoints on the home server

This creates a second persistence system and splits recovery logic across the
home server and Actions. The chosen design keeps all file processing and
collection state in the Action/archive workflow.
