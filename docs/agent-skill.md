---
title: "Daski provider agent skill"
status: canonical
authority: current repository implementation and approved maintainer workflow
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16 (documentation placement; no live release verification)
supersedes: repository-wide agent files as the home of general repository guidance
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/provider-full
review-trigger: setup, architecture, interface or workflow change
---

# Daski provider agent skill

The canonical portable skill is published only by the minimal
[daski-io/provider](https://github.com/daski-io/provider) repository, at
[`.agents/skills/daski-provider/`](https://github.com/daski-io/provider/tree/develop/.agents/skills/daski-provider).

`provider-full` deliberately keeps no copy. One maintained skill prevents
routing, safety stops, and onboarding language from drifting between the two
starters.

## Installing it

Install the canonical skill with the command the Daski provider page uses:

```sh
npx skills add https://github.com/daski-io/provider --skill daski-provider
```

or reference `.agents/skills/daski-provider/SKILL.md` from a checkout of
`daski-io/provider` through your coding-agent harness's own skill mechanism.

An installed skill does not update itself when the repository changes. Re-run
the install command to refresh an older installation, and check that the
installed skill's version matches the `daski-io/provider` release you build
against, since the skill describes that starter's capabilities at its
version.

## How it routes to provider-full

The skill selects a path from the product's facts: the minimal starter's
synchronous mode, its external-job mode (in releases that include it), or
this repository. It selects `provider-full` for dynamic pricing,
provider-owned multi-step workflows, later input or cancellation, assets and
owner actions, human or operator review, richer protected data, email,
admin, direct A2A, or intentional multi-replica operation. Duration alone
does not select this repository, and selecting it never replaces a missing
product guarantee, such as a way to find a submission again after a lost
response.

Recovery after a provider-terminal paid failure is not part of this release:
an agent must not promise it. Overdue but still-open work and late result
delivery are supported and are a different thing.

## Using the skill with provider-full

Once `provider-full` is selected, this repository's `README.md` and tracked
`docs/` are authoritative. The installed skill is only the cross-repository
router; it must not override the full `ServiceModule`, lifecycle, asset,
protected-data, worker, or operations contracts documented here. Read
[Integrating an existing product](integrating-existing-product.md), and for a
product that returns a job id,
[Wrapping a product that returns a job id](existing-async-products.md),
before writing an adapter.

Recommended prompt:

```text
Use the canonical Daski provider skill to choose the starter. We are already in
provider-full because this product needs <full feature>. Read this repository's
README.md and relevant docs completely before editing. Map only the reviewed
API/MCP operations, use fake-client tests, and stop before live product calls,
signing, deployment, registration, funding, Mainnet changes, or pushes unless
explicitly authorized.
```

Never send wallet keys, `.env`, API tokens, customer/protected data, signed
artifacts, supplier account data, or raw production responses to an agent.

## Updating the skill

Change the skill in `daski-io/provider`, validate it there, and release it
from that repository with its version. Update this guide only when the link,
the install command or the boundary between the minimal and full starters
changes.
