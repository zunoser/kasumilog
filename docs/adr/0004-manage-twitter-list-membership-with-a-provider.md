# ADR 0004: Manage Twitter list membership with a Terraform provider

- Status: Proposed
- Date: 2026-08-18

## Decision Drivers

- Adding or removing a catalog account should be an ordinary reviewed pull request.
- An incomplete `ListMembers` response must never justify removing a member.
- Pull request code must not receive Tailscale credentials or reach the Relay.
- The provider must reuse the reviewed Relay operation locks and conservative pacing.
- The existing private list must not be created, deleted, or renamed by the first version.

## Context

The TypeScript exact-sync command already treats active catalog accounts as the
desired set, reads every `ListMembers` page, adds missing IDs, removes unmanaged
IDs, and verifies the final complete set. It is intentionally a manual command,
so the desired state and the act of applying it are not represented in Terraform
state or a normal plan/apply workflow.

Managing one Terraform resource per list member would cause repeated list reads,
parallel mutations, and unnecessary Relay load. The remote API exposes the list
membership as one paginated collection, and removal is safe only after that
collection has been observed completely.

The Relay is reachable only through Tailscale. HCP Terraform remote runners
cannot use that route. Pull request workflows are also an inappropriate place
for Tailscale credentials or Twitter write access.

## Options Considered

- Keep only the TypeScript exact-sync command. This is simple but does not give
  us state, refresh, drift plans, import, or a conventional declarative workflow.
- Model every member as a separate resource. This matches CRUD mechanically but
  is inefficient and cannot prove that unmanaged members are safe to remove.
- Model the complete membership policy as one resource. This matches the remote
  pagination and the existing exact-sync safety boundary.

## Decision

Build an internal Go provider with Terraform Plugin Framework protocol v6. The
provider talks only to the reviewed Twitter Relay and initially exposes one
resource:

```hcl
resource "twitterrelay_list_membership_set" "kasumilog" {
  list_id    = var.list_id
  member_ids = var.member_ids

  lifecycle {
    prevent_destroy = true
  }
}
```

`member_ids` is a set of Twitter numeric IDs. The resource owns the exact member
set of one already-existing list. It does not own the list object itself.

- Import is the supported adoption path. `ImportState` stores the list ID and
  `Read` populates the complete observed membership before the first plan.
- `Create` refuses with an import instruction. Version 1 never calls
  `CreateList`, so a first plan cannot conceal removals from an existing list.
- `Read` performs a complete, bounded `ListMembers` walk and writes the observed
  member set into state. A partial or malformed walk fails refresh.
- `Update` re-reads the complete remote set and requires it to equal prior state.
  Drift after planning therefore aborts apply and requires a new plan. It then
  adds missing IDs, removes unmanaged IDs, and performs a final complete read.
- `Delete` forgets the policy state without changing Twitter. It never clears a
  list or deletes the list. The checked-in module also uses `prevent_destroy` so
  abandoning management must be an explicit configuration change.

The provider executes one request at a time with a minimum 15-second delay plus
zero to 10 seconds jitter. It does not immediately retry in version 1. Only the
reviewed `ListMembers`, `ListAddMember`, and `ListRemoveMember` operations are
allowed. The current narrow exception for the known list-banner code 214 decode
error remains valid only for mutations; final complete membership is the source
of success.

The TypeScript collector and Go provider share a language-neutral local override
file. The upstream `requests.ndjson` remains the base catalog and provenance.
An effective operation consists of its method, operation name, query ID,
features, fixed variables, base content hash, override content hash, and
effective template hash. Runtime code may add only `listId`, `userId`, and
`cursor` in the operation that permits each value.

Pull requests receive no Relay or Tailscale access. They validate the catalog,
build and test the provider, generate the sorted active-ID set in a temporary
file, and show a handle-oriented desired-set diff against the base commit. This
is deliberately not described as a live Terraform plan.

After merge, a trusted default-branch workflow joins Tailscale and performs a
read-only live plan. Applying is a separate `workflow_dispatch` that requires
the expected catalog revision, creates a fresh saved plan, and applies that exact
plan in the same job. The provider's pre-mutation drift check remains the final
guard. Neither `pull_request_target` nor automatic apply on merge is used.

Use an HCP Terraform workspace in local execution mode for state and locking.
Terraform CLI and the provider run inside GitHub Actions, where Tailscale is
available; HCP Terraform stores state only. Provider binaries are built from the
trusted repository revision and installed from an Actions-local filesystem
mirror for the proof of concept. Registry publication is deferred.

## Consequences

- Positive: adding an account remains one catalog change in a PR; the generated
  Twitter ID set is not a second committed source of truth.
- Positive: refresh and plans expose drift, while complete-snapshot and stale-plan
  checks prevent destructive changes based on partial or old observations.
- Positive: no Twitter credential, cookie, or Relay secret is stored in state;
  Tailscale network identity remains the authentication boundary.
- Negative: this is intentionally more machinery than the current script: Go,
  provider packaging, remote state, and two trusted workflows.
- Negative: plans can fail when private GraphQL query locks drift. Recapturing and
  reviewing the whole operation lock is required before trying again.
- Negative: a large exact sync remains slow because mutations are sequential and
  paced. Terraform must not parallelize membership operations internally.

## Adoption and Exceptions

- Phase 1 implements the shared override file, provider resource, fake-Relay
  tests, temporary catalog export, and local module. It does not add live apply.
- Phase 2 adds secretless PR checks and a trusted post-merge read-only plan.
- Phase 3 enables manual apply only after account2/private-list acceptance tests.
- Live acceptance tests are manual and target only the existing account2 private
  list. Normal CI uses a fake Relay and no Twitter access.
- Supporting list creation, list metadata, public lists, multiple browser
  profiles, automatic apply, or a public provider release requires a later ADR.

## References

- [Terraform Plugin Framework resource import](https://developer.hashicorp.com/terraform/plugin/framework/resources/import)
- [Terraform Plugin Framework update lifecycle](https://developer.hashicorp.com/terraform/plugin/framework/resources/update)
- [Terraform Plugin Framework acceptance tests](https://developer.hashicorp.com/terraform/plugin/framework/acctests)
- [HCP Terraform local execution mode](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/settings#execution-mode)
- [OpenTofu filesystem provider mirrors](https://opentofu.org/docs/v1.11/cli/config/config-file/#explicit-installation-method-configuration)
