# Daski Provider integration skill for coding agents

The canonical portable skill is published only by the minimal
[daski-io/provider](https://github.com/daski-io/provider) repository:

```text
.agents/skills/daski-provider/SKILL.md
```

Its public skill id is `daski-provider`. Inspect the
[canonical source](https://github.com/daski-io/provider/tree/develop/.agents/skills/daski-provider)
and follow the provider repository's
[installation, invocation, release, and compatibility guide](https://github.com/daski-io/provider/blob/develop/docs/agent-skill.md).

`provider-full` deliberately does not keep a second copy. One maintained skill
prevents routing, safety stops, installation guidance, and onboarding language
from drifting between the two starters. This repository's architecture gate
fails if `.agents/skills/daski-provider` is added here.

## Use the skill with provider-full

Install the canonical skill before checkout when an agent still needs to
choose between `provider` and `provider-full`. The canonical guide recommends a
project-scope install for team and remote-agent workflows. If this full starter
is already checked out and a local user still wants the router available across
projects, use user scope rather than creating a second tracked package here:

```bash
npx skills add daski-io/provider --skill daski-provider --global
```

Do not add `--yes`; retain the installer review and confirmation step. A
machine-global install does not travel to remote or cloud agents. After this
repository has been selected, an additional skill installation is not required
because this revision's `AGENTS.md`, `README.md`, `SECURITY.md`, and `docs/` are
authoritative.

The skill should select this full starter when the product needs dynamic
quotes, long-running jobs, later input, durable assets/actions, human review,
email, admin, direct A2A, protected-data workflows, or multi-replica recovery.
It is only the cross-repository router; it must not override the full
`ServiceModule`, lifecycle, asset, protected-data, worker, registration, or
operations contracts documented here.

Recommended prompt:

```text
Use the installed daski-provider skill. We are already in provider-full because
this product needs <full feature>. Read this repository's AGENTS.md and relevant
docs completely before editing. Map only the reviewed API/MCP operations, use
fake-client tests, and stop before live product calls, signing, deployment,
registration, funding, Mainnet changes, or pushes unless explicitly authorized.
```

Installing or invoking the skill is not authority to deploy, register, sign,
spend, call a live product, push, tag, or release. Never send wallet keys,
`.env`, API tokens, customer/protected data, signed artifacts, supplier account
data, or raw production responses to an agent.

## Update policy

Change and validate the skill only in `daski-io/provider`, and release its
standalone archive only from that repository. Update this guide when the
canonical link, public name, installation handoff, or minimal-versus-full
boundary changes. Never copy the skill body or its compatibility matrix here.
