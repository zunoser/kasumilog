# Terraform provider design for Twitter list membership

This document turns ADR 0004 into an implementation-sized proof of concept. It
does not authorize Relay calls or Twitter mutations.

## 1. User experience

The normal contribution remains a catalog pull request:

1. Add or change an account in `src/catalog.ts`, including its verified Twitter
   ID, status, subjects, and verification date.
2. Run the existing catalog tests and the new member export check.
3. Open a pull request. CI shows a summary such as:

   ```text
   desired membership: 30 (+1, -0)
   + @example_go_jp 1234567890
   ```

4. Merge the reviewed pull request.
5. The trusted default-branch plan reports live drift without changing Twitter.
6. An operator copies the catalog revision from that plan into the manual apply
   dispatch. Apply re-plans against current state and applies that saved plan.

The PR does not edit HCL membership rows. `src/catalog.ts` remains the only
curated account source. A deterministic exporter produces a temporary tfvars
file from active accounts:

```json
{
  "member_ids": ["1234567890", "265205959"],
  "catalog_revision": "<sha256>"
}
```

IDs are unique strings sorted lexicographically. The exporter fails if catalog
validation fails. CI also exports the merge base and produces the friendly
handle diff; the provider receives IDs only.

## 2. Repository layout

```text
provider/terraform-provider-twitterrelay/
  go.mod
  main.go
  internal/provider/
    provider.go
    list_membership_set_resource.go
  internal/relay/
    client.go
    members.go
    version_lock.go
  internal/testrelay/
infra/twitter-list/
  main.tf
  providers.tf
  variables.tf
  README.md
config/
  twitter-relay-overrides.json
scripts/
  export-terraform-members.ts
.github/workflows/
  twitter-list-pr.yml
  twitter-list-plan.yml
  twitter-list-apply.yml
```

The first implementation keeps the provider in this repository. It does not
create another repository, publish a Registry package, or introduce a general
provider release pipeline.

## 3. Shared Relay version lock

The current override values in `src/relay-overrides.ts` move mechanically to
`config/twitter-relay-overrides.json`. TypeScript and Go both validate and read
that file. The JSON contains only the captured operations used by kasumilog:

```json
{
  "schemaVersion": 1,
  "operations": {
    "ListMembers": {
      "queryId": "...",
      "method": "GET",
      "features": {},
      "variables": { "count": 20 }
    },
    "ListAddMember": {
      "queryId": "...",
      "method": "POST",
      "features": {},
      "variables": {}
    },
    "ListRemoveMember": {
      "queryId": "...",
      "method": "POST",
      "features": {},
      "variables": {}
    }
  }
}
```

Features and fixed variables replace, rather than merge with, the upstream
example. This prevents old sample IDs, cursors, or flags from leaking into a
request. The path is derived as `/graphql/<queryId>/<operation>`.

The provider configuration receives paths and expected identities from the
trusted workflow:

```hcl
provider "twitterrelay" {
  base_url                 = "https://tw.home.yutakobayashi.com"
  profile_name             = "account2"
  request_catalog_path     = var.request_catalog_path
  request_catalog_revision = var.request_catalog_revision
  request_catalog_sha256   = var.request_catalog_sha256
  override_path            = var.override_path
}
```

Provider configuration is not resource state. Configure validates the complete
base catalog and the strict override schema before any Relay request. Unknown
keys, duplicate operations, unsupported methods, bad query IDs, non-HTTPS base
URLs, and unsupported profiles fail closed.

Only these runtime substitutions are permitted:

| Operation | Runtime values | Method |
| --- | --- | --- |
| `ListMembers` | `listId`, optional `cursor` | GET |
| `ListAddMember` | `listId`, `userId` | POST |
| `ListRemoveMember` | `listId`, `userId` | POST |

Every request carries `x-profile-name: account2`, uses
`accept-encoding: identity`, rejects redirects, and has a finite timeout. No
cookie, bearer token, response body, cursor, or HTTP header is written to
Terraform state or normal workflow output.

## 4. Provider and resource schema

Provider source for the POC is `registry.terraform.io/zunoser/twitterrelay`.
The binary uses Terraform Plugin Framework protocol v6.

Resource `twitterrelay_list_membership_set`:

| Attribute | Mode | Meaning |
| --- | --- | --- |
| `list_id` | required, replace | Existing Twitter list numeric ID |
| `member_ids` | required set(string) | Exact desired Twitter user IDs |

Validators require positive decimal IDs, a non-empty member set, unique values,
and a finite maximum of 200 members. The set type makes HCL order irrelevant.
The provider sorts IDs before requests and diagnostics.

The checked-in configuration is deliberately small:

```hcl
terraform {
  required_version = ">= 1.8, < 2.0"

  required_providers {
    twitterrelay = {
      source  = "zunoser/twitterrelay"
      version = "0.1.0"
    }
  }

  cloud {
    organization = "zunoser"
    workspaces { name = "kasumilog-twitter-list" }
  }
}

resource "twitterrelay_list_membership_set" "kasumilog" {
  list_id    = var.list_id
  member_ids = var.member_ids

  lifecycle { prevent_destroy = true }
}

import {
  to = twitterrelay_list_membership_set.kasumilog
  id = var.list_id
}
```

The exact organization name is configuration, not an architectural assumption;
it is set when the workspace is created.

## 5. Lifecycle behavior

### Configure

1. Validate the Relay origin, profile, base catalog hash/revision, and override.
2. Build exactly three effective operations.
3. Refuse configuration if any operation is missing or ambiguous.

No network call occurs during provider configuration.

### Import and Read

Import accepts one positive decimal list ID. Read walks `ListMembers` from the
head until an explicit end condition, deduplicates Twitter IDs, and writes the
complete observed set to state.

Read fails without changing state when any of these occurs:

- HTTP failure, invalid JSON, or unexpected GraphQL error;
- expected list-member timeline shape missing;
- repeated cursor or page limit;
- a page cannot be proven complete.

An incomplete read is never converted into an empty or smaller set.

### Create

Create returns a diagnostic directing the operator to import the existing list.
The POC cannot create a Twitter list. This preserves a truthful first plan: the
remote membership is observed before Terraform proposes removals.

### Update

1. Read the complete remote set again.
2. Compare it with the prior Terraform state. If they differ, stop with
   `remote membership changed after planning`; no mutation is sent.
3. Compute additions and removals from the fresh remote set to planned set.
4. Add missing IDs in sorted order.
5. Remove unmanaged IDs in sorted order.
6. Read all members again and require exact equality with planned state.
7. Store the verified planned set.

Add-before-remove prevents a transient unexpectedly empty list. A response with
the exact known banner-field code 214 decode error may continue only for add or
remove; final Read determines whether the mutation succeeded.

### Delete

Delete sends no Relay request and removes the resource from state. The provider
does not own the list object and must never infer that destroying policy state
means clearing or deleting a Twitter list. `prevent_destroy` makes this behavior
an explicit operator choice in the canonical module.

## 6. Pagination, pacing, and failure policy

- One provider instance has one request gate; request concurrency is always one.
- Wait at least 15 seconds plus zero to 10 seconds jitter between responses and
  the next request, across reads and mutations.
- Use a ten-page member-read ceiling in the POC. Exceeding it is an error, not a
  partial snapshot.
- Follow only the Bottom cursor from the exact `ListMembers` timeline container.
- Reject equal or previously seen cursors.
- Do not retry in version 1. A later retry policy needs persisted `notBefore`
  behavior or another ADR; immediate retries are not acceptable.
- Provider diagnostics contain operation name and status class, but never URL
  query strings, cursors, list IDs, user IDs, raw payloads, or arbitrary upstream
  error text.

Terraform cancellation propagates through request contexts. Cancellation stops
before the next request. A partially applied series is repaired by the next
refresh and plan; the final state is written only after exact verification.

## 7. State and execution

Create an HCP Terraform workspace named `kasumilog-twitter-list` with execution
mode `Local`. HCP stores state versions and provides locking, but Actions runs
Terraform and the provider locally so the process can join Tailscale. HCP
workspace variables are not relied upon in local execution mode.

State contains only list ID and member IDs. These IDs are not credentials, but
state is still private. Relay bodies, operation templates, filesystem paths,
catalog rows, handles, and Tailscale credentials are excluded.

The Actions job builds version `0.1.0` from the checked-out trusted commit into
an unpacked filesystem mirror:

```text
<mirror>/registry.terraform.io/zunoser/twitterrelay/0.1.0/linux_amd64/
  terraform-provider-twitterrelay_v0.1.0
```

`TF_CLI_CONFIG_FILE` permits that mirror for `zunoser/twitterrelay` and uses
direct installation for other providers. Development overrides are not used in
CI because they intentionally bypass normal lock-file selection.

## 8. GitHub Actions trust boundaries

### Pull request: `twitter-list-pr.yml`

Permissions are `contents: read`. It has no Environment, Tailscale action, HCP
token, or Relay access.

1. Test the TypeScript catalog and exporter.
2. Run `go test ./...` for the provider with the fake Relay.
3. Build the provider.
4. Run `terraform fmt -check` and `terraform init -backend=false`/`validate`.
5. Export active members at the PR head and base commit.
6. Write a sanitized desired-set diff to the step summary.

This is a static desired-state preview, not a live Terraform plan.

### Trusted plan: `twitter-list-plan.yml`

Trigger on successful merge to the default branch and allow manual dispatch.
Use the same static concurrency group as list apply so only one state/Relay
operation runs at a time.

1. Check out the exact default-branch commit with no persisted Git credential.
2. Validate and test before joining Tailscale.
3. Build the provider and filesystem mirror.
4. Fetch and verify the pinned upstream `requests.ndjson`.
5. Export temporary tfvars and catalog revision.
6. Join Tailscale with the existing live Environment credentials.
7. Run `terraform plan -detailed-exitcode` using HCP local state.
8. Publish only revision, counts, and reviewed handle changes to the summary.

The plan does not run on pull request code and is never applied automatically.

### Manual apply: `twitter-list-apply.yml`

`workflow_dispatch` accepts one input: `catalog_revision`. The job requires that
the selected ref is the current default-branch HEAD and that the freshly exported
revision exactly matches the input.

The job repeats trusted validation, joins Tailscale, runs
`terraform plan -out=$RUNNER_TEMP/list.tfplan`, and applies that exact file in the
same job. No plan artifact crosses jobs or runs. This avoids artifact provenance
and stale-plan machinery. The provider still re-reads membership before the first
mutation and aborts if it differs from prior state.

Apply is never triggered by `pull_request`, `pull_request_target`, merge, label,
comment, schedule, or reusable workflow. The workflow has no archive-branch
write permission.

## 9. Tests

Pure Go tests use an `httptest` Relay, fake clock, sleeper, and random source.
They cover:

- strict operation-lock parsing and runtime variable allowlists;
- complete multi-page reads, deduplication, terminal cursor, repeated cursor;
- initial import and refresh drift;
- additions before removals, deterministic order, and exact final verification;
- no mutation after incomplete read or stale prior state;
- known mutation-only code 214 handling and unknown GraphQL error rejection;
- actual request start intervals with fake time;
- Create refusal and no-op Delete;
- cancellation during pacing or a request.

Plugin Framework tests use `terraform-plugin-testing` protocol v6 against the
fake Relay for import, refresh, update, no-diff follow-up plan, and destroy. A
manual `TF_ACC=1` suite is the only test that reaches account2 and the private
list; it is excluded from normal CI and never removes an unmanaged fixture unless
that fixture was created for the test.

## 10. Implementation slices

1. **Shared inputs:** add strict JSON override, make TypeScript consume it, and
   add deterministic catalog-to-tfvars export. No provider or live change yet.
2. **Provider POC:** implement client, exact-set resource, fake tests, HCL module,
   Nix Go/Terraform tooling, and filesystem-mirror build.
3. **Secretless PR UX:** add the desired membership summary and provider checks.
4. **Read-only live plan:** create the HCP local-mode workspace and trusted plan
   workflow; validate repeated no-change plans.
5. **Manual apply:** enable only after import and two successful read-only plans,
   then test one catalog addition on the account2 private list.

## 11. Explicit non-goals for version 1

- creating, deleting, renaming, or changing privacy of Twitter lists;
- managing one membership per Terraform resource;
- following/unfollowing accounts;
- multiple Relay origins or browser profiles;
- automatic query-ID discovery or fallback query IDs;
- retries, parallel mutations, or configurable faster pacing;
- automatic apply on merge;
- public Registry publication or semantic release automation;
- moving the canonical catalog from TypeScript.

## References

- [How Terraform uses provider plugins](https://developer.hashicorp.com/terraform/plugin/how-terraform-works)
- [Terraform Plugin Framework set attributes](https://developer.hashicorp.com/terraform/plugin/framework/handling-data/attributes/set)
- [Terraform Plugin Framework resource import](https://developer.hashicorp.com/terraform/plugin/framework/resources/import)
- [Terraform Plugin Framework plan modification](https://developer.hashicorp.com/terraform/plugin/framework/resources/plan-modification)
- [Terraform Plugin Framework acceptance tests](https://developer.hashicorp.com/terraform/plugin/framework/acctests)
- [HCP Terraform workspace execution modes](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/settings#execution-mode)
- [Terraform filesystem mirrors](https://developer.hashicorp.com/terraform/cli/config/config-file#explicit-installation-method-configuration)
- [OpenTofu filesystem mirrors](https://opentofu.org/docs/v1.11/cli/config/config-file/#explicit-installation-method-configuration)
