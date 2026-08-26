# Daski provider agent skill

The canonical portable skill is published only by the minimal
[daski-io/provider](https://github.com/daski-io/provider) repository:

```text
.agents/skills/daski-provider/SKILL.md
```

`provider-full` deliberately does not keep a second copy. One maintained skill
prevents routing, safety stops, and onboarding language from drifting between
the two starters.

## Using the skill with provider-full

Install or reference the canonical skill using the supported mechanism in your
Claude, Codex, or other coding-agent harness. If the product needs dynamic
quotes, long-running jobs, later input, durable assets/actions, human review,
email, admin, direct A2A, or multi-replica recovery, the skill should select
this full starter.

Once `provider-full` is selected, this repository's `AGENTS.md` and tracked
`docs/` are authoritative. The installed skill is only the cross-repository
router; it must not override the full `ServiceModule`, lifecycle, asset,
protected-data, worker, or operations contracts documented here.

Recommended prompt:

```text
Use the canonical Daski provider skill to choose the starter. We are already in
provider-full because this product needs <full feature>. Read this repository's
AGENTS.md and relevant docs completely before editing. Map only the reviewed
API/MCP operations, use fake-client tests, and stop before live product calls,
signing, deployment, registration, funding, Mainnet changes, or pushes unless
explicitly authorized.
```

Never send wallet keys, `.env`, API tokens, customer/protected data, signed
artifacts, supplier account data, or raw production responses to an agent.

## Updating the skill

Change the skill in `daski-io/provider`, validate it there, and release its
standalone archive from that repository. Update this guide only when the link or
the boundary between minimal and full changes.
