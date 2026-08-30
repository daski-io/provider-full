import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

async function publicSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await publicSourceFiles(path));
    } else if (/\.(?:ts|js|mjs|json|sql|md|ya?ml)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const files = [
  join(ROOT, "README.md"),
  join(ROOT, "SECURITY.md"),
  join(ROOT, "CONTRIBUTING.md"),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "CHANGELOG.md"),
  join(ROOT, "scripts/README.md"),
  ...await markdownFiles(join(ROOT, "docs")),
];

const sources = new Map(await Promise.all(files.map(async (path) => [
  path,
  await readFile(path, "utf8"),
])));

for (const [path, source] of sources) {
  const relativePath = path.slice(ROOT.length + 1).replaceAll("\\", "/");
  if (/\b(?:TODO|TBD)\b/.test(source)) {
    failures.push(`${relativePath} contains an unfinished TODO/TBD marker`);
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    const resolved = resolve(dirname(path), decodeURIComponent(target));
    try {
      await access(resolved);
    } catch {
      failures.push(`${relativePath} has a broken local link: ${match[1]}`);
    }
  }
}

const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const documentedCommands = new Set();
for (const source of sources.values()) {
  for (const match of source.matchAll(/\bnpm run (?:--silent )?([a-zA-Z0-9:_-]+)/g)) {
    documentedCommands.add(match[1]);
  }
}
for (const command of documentedCommands) {
  if (!packageJson.scripts?.[command]) {
    failures.push(`documentation references missing npm script: ${command}`);
  }
}

const envExample = await readFile(join(ROOT, ".env.example"), "utf8");
const documentedConfiguration = await readFile(
  join(ROOT, "docs/configuration.md"),
  "utf8",
);
const exampleVariables = new Set(envExample.split(/\r?\n/).flatMap((line) => {
  const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
  return match ? [match[1]] : [];
}));
for (const variable of exampleVariables) {
  if (!documentedConfiguration.includes(`\`${variable}\``)) {
    failures.push(`docs/configuration.md does not cover ${variable}`);
  }
}

const genericityFiles = [
  ...files,
  join(ROOT, ".env.example"),
  join(ROOT, "package.json"),
  ...await publicSourceFiles(join(ROOT, "src")),
  ...await publicSourceFiles(join(ROOT, "test")),
  ...await publicSourceFiles(join(ROOT, "scripts")),
].filter((path) =>
  path !== join(ROOT, "CHANGELOG.md") &&
  path !== join(ROOT, "scripts", "docs-check.mjs")
);
const genericSources = (await Promise.all(
  [...new Set(genericityFiles)].map((path) => readFile(path, "utf8")),
)).join("\n");
for (const forbidden of [
  "Blue T Group",
  "OpenSRS",
  "Corporate Tools",
  "Northwest Registered Agent",
  "Name.com",
  "domain-management",
  "mailboxes",
  "entity-formation",
  "PAYMENT_ROUTER_ADDRESS",
  "daski-exact",
]) {
  if (genericSources.toLowerCase().includes(forbidden.toLowerCase())) {
    failures.push(`public starter contains forbidden legacy/provider term: ${forbidden}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `documentation checks passed (${files.length} Markdown files, ` +
    `${exampleVariables.size} example variables)\n`,
);
