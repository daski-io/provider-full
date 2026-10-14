// Set services.agent_domain on the selected service so the
// next ServiceRegistrar bootstrap can register it on-chain.

import pg from "pg";

const DBURL = process.argv[2];
const SLUG = process.argv[3];
const DOMAIN = process.argv[4];

if (!DBURL || !SLUG || !DOMAIN) {
  console.error("usage: node set-agent-domain.mjs <db-url> <slug> <agent-domain>");
  process.exit(1);
}

const c = new pg.Client({ connectionString: DBURL });
await c.connect();
// Declare the runtime epoch this release writes under (core migration 011).
await c.query("SET daski.runtime_epoch = '1'");
const r = await c.query(
  "UPDATE services SET agent_domain = $1, updated_at = now() WHERE slug = $2 RETURNING id, slug, agent_domain",
  [DOMAIN, SLUG],
);
console.log(JSON.stringify(r.rows[0]));
await c.end();
