# kasumilog

An account catalog and reproducible raw archive for Japanese central-government
posts on X/Twitter.

kasumilog keeps accounts separate from the organizations, people, and public
roles behind them. It collects complete Relay responses into a private Git
archive, then builds disposable local search indexes from that raw data.

## Use cases

- Maintain a reviewed catalog of ministries, agencies, office holders, and
  related official accounts.
- Keep a private X List synchronized with the active catalog.
- Collect the list timeline on a bounded, rate-conscious schedule.
- Preserve full HTTP/GraphQL response bodies for future reprocessing.
- Build a local SQLite/FTS5 index and search Japanese post text.

## Current status

- 29 cataloged accounts with verified Twitter IDs.
- Exact synchronization against the private `kasumilog` list is working.
- Bounded timeline collection runs hourly at minute 17 and can also be started
  manually.
- Raw responses and manifests are stored on the private `archive` branch.
- SQLite/FTS5 search is a disposable local projection and is never committed.
- Declarative list management with a Terraform provider is designed but not yet
  implemented.

## Quick start

Requirements:

- Node.js 22.13 or newer
- Git

The project has no runtime npm dependencies.

```sh
git clone https://github.com/zunoser/kasumilog.git
cd kasumilog
npm test
```

## Search the archive

Use a checkout or worktree containing the private `archive` branch, then build a
fresh local database from its `data/raw` directory:

```sh
npm run search:rebuild -- \
  --raw-root /path/to/archive/data/raw \
  --database state/kasumilog.sqlite \
  --json
```

Search with literal Japanese substring matching:

```sh
npm run search -- \
  --database state/kasumilog.sqlite \
  --query '内閣総理' \
  --limit 20 \
  --json
```

Pass the returned `nextCursor` back with `--cursor` to fetch the next page.
Rebuild the database whenever the raw archive or parser changes; the database is
derived data and is safe to delete.

## Collection

Normal live collection runs through
[`Archive bounded timeline collection`](.github/workflows/archive-collection-live.yml).
The workflow:

1. validates the pinned Relay request catalog and collector;
2. joins the private tailnet;
3. fetches one bounded timeline walk;
4. commits raw bodies and manifests to `archive`;
5. verifies the pushed bytes from a clean clone before advancing coverage.

Every run starts at the timeline head and stops after it overlaps the previous
coverage frontier. Cursors are used only inside one run. Partial runs preserve
their raw responses but do not advance coverage.

To exercise the storage pipeline without contacting Twitter:

```sh
npm run collect:fixture -- \
  --fixture test/fixtures/list-timeline-page.capture.json \
  --repository /path/to/archive-worktree \
  --branch archive \
  --json
```

## Synchronize list members

The catalog in [`src/catalog.ts`](src/catalog.ts) is the desired member set. The
exact-sync command reads every `ListMembers` page, adds missing accounts, removes
unmanaged accounts, and verifies the final complete set.

```sh
npm run list:sync-members -- /path/to/requests.ndjson
```

> [!CAUTION]
> This command changes the real private X List. It is intentionally locked to
> the `account2` Relay profile and the kasumilog list. Requests run sequentially
> with conservative pacing and no automatic retry.

An incomplete member snapshot can never trigger removals.

## Commands

| Command | Purpose | Network or write effect |
| --- | --- | --- |
| `npm test` | Run the Node.js test suite | None |
| `npm run search:rebuild` | Rebuild disposable SQLite/FTS from raw data | Local files only |
| `npm run search` | Search a local SQLite index | None |
| `npm run collect:fixture` | Test raw storage and Git verification | Writes only to the supplied Git target |
| `npm run plan:timeline` | Build a sanitized collection plan | No Relay request |
| `npm run collect:timeline` | Execute one bounded live collection | Read-only Twitter request; normally Actions-only |
| `npm run list:sync-members` | Exact-sync private list membership | Changes the X List |

## Data model

A Twitter account is not treated as the entity behind it:

```text
post -> account -> organization | person | role
```

This keeps an institutional account such as `@kantei` separate from the current
prime minister. Time-bounded role assignments preserve correct attribution when
office holders change. Posts are classified into four intentionally broad
domains: `administration`, `politics`, `legislature`, and `judiciary`.

## Contributing

### Add or update an account

1. Verify the official handle and Twitter internal ID.
2. Add any missing organization, person, role, or role assignment in
   [`src/catalog.ts`](src/catalog.ts).
3. Add or update the account with its `status`, `verifiedAt`, and subject links.
4. Give personal accounts a reviewed `defaultDomain` when they should be
   collected automatically.
5. Run `npm test`.
6. Open a pull request explaining the source used for identity verification.

Do not add generated search databases, normalized exports, or raw responses to
`main`. The collection workflow is the only normal writer for `data/raw` on the
`archive` branch.

### Change Relay operations

Treat a captured operation as one version lock: query ID, variables, features,
and field toggles must be reviewed together. Update
[`src/relay-overrides.ts`](src/relay-overrides.ts) and its tests rather than
adding fallback query IDs or changing individual flags at runtime.

### Before opening a PR

```sh
npm test
git diff --check
```

Update the README only when user-facing usage changes. Architecture and safety
decisions belong in the linked ADRs and design documents.

## Documentation

- [Archive pipeline and recovery](docs/design/archive-pipeline.md)
- [Terraform provider design](docs/design/terraform-twitter-list-provider.md)
- [ADR 0001: immutable raw data and local projections](docs/adr/0001-immutable-raw-and-local-projections.md)
- [ADR 0002: disposable SQLite search](docs/adr/0002-use-disposable-sqlite-search-poc.md)
- [ADR 0003: bounded timeline collection](docs/adr/0003-bound-timeline-collection.md)
- [ADR 0004: declarative list membership](docs/adr/0004-manage-twitter-list-membership-with-a-provider.md)
