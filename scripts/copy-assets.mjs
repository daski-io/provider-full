import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Copy runtime assets into dist after tsc. Generic by design: every
// service folder's `docs/` and `content/` ships automatically, so adding
// or removing a service never touches the build script. `.ts` files are
// skipped (tsc emits their compiled form separately).
//
// The build also embeds its source identity (dist/build-identity.json): a
// digest of exactly the sources an image build receives (the Docker context
// excludes tests, fixtures and captures), and the commit the build was given
// in SOURCE_COMMIT, if any. Hosting metadata is never consulted.

const EXCLUDED_DIRECTORIES = new Set(["tests", "fixtures", "captures", "audits", "reports"]);
const EXCLUDED_FILES = /(?:^audit-.*\.md|-audit-.*\.md|audit-report.*\.md|implementation-report.*\.md|\.log)$/;

function sourceFiles(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(root, path);
    return EXCLUDED_FILES.test(entry.name) ? [] : [path];
  });
}

/** sha256 over the relative path and content digest of every built source, in path order. */
export function sourceDigest(root = ".") {
  const files = [
    "package.json", "package-lock.json", "tsconfig.json", ...sourceFiles(root, "src"),
  ].map((path) => relative(root, resolve(root, path)).replaceAll("\\", "/")).sort();
  const digest = createHash("sha256");
  for (const path of files) {
    const content = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    digest.update(`${path}\0${content}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

export function buildIdentity(root = ".", env = process.env) {
  const commit = env.SOURCE_COMMIT?.trim().toLowerCase() || null;
  if (commit !== null && !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error("SOURCE_COMMIT must be a 7 to 40 character hexadecimal commit id");
  }
  return { schemaVersion: 1, sourceDigest: sourceDigest(root), sourceCommit: commit };
}

function copyAssets() {
  const copies = [
    ["src/core/db/migrations", "dist/core/db/migrations"],
    ["src/core/admin/ui/static", "dist/core/admin/ui/static"],
  ];
  for (const entry of readdirSync("src/services", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const dir of ["docs", "content"]) {
      copies.push([
        join("src/services", entry.name, dir),
        join("dist/services", entry.name, dir),
      ]);
    }
  }
  for (const [from, to] of copies) {
    if (!existsSync(from)) continue;
    cpSync(from, to, {
      recursive: true,
      filter: (source) => !source.endsWith(".ts"),
    });
  }
  writeFileSync("dist/build-identity.json", `${JSON.stringify(buildIdentity())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) copyAssets();
