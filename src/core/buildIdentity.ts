import { readFileSync } from "node:fs";

/*
 * The source identity embedded in the compiled artifact at build time
 * (scripts/copy-assets.mjs writes dist/build-identity.json): a digest of the
 * exact source tree the image was built from, and the source commit when the
 * build was given one. It describes the artifact itself, whatever hosts it;
 * hosting metadata is never required.
 */

export interface BuildIdentity {
  /** sha256 over the built source tree; null when running uncompiled sources. */
  sourceDigest: string | null;
  /** The commit the build was told it was built from, if any. */
  sourceCommit: string | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const EMBEDDED = new URL("../build-identity.json", import.meta.url);

let cached: BuildIdentity | null = null;

export function parseBuildIdentity(source: string): BuildIdentity {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  if (parsed.schemaVersion !== 1 || typeof parsed.sourceDigest !== "string" || !DIGEST.test(parsed.sourceDigest)) {
    throw new Error("build identity is malformed");
  }
  const commit = parsed.sourceCommit;
  if (commit !== null && (typeof commit !== "string" || !COMMIT.test(commit))) {
    throw new Error("build identity commit is malformed");
  }
  return { sourceDigest: parsed.sourceDigest, sourceCommit: commit };
}

/** Read an identity file; a missing file (uncompiled sources) has none. */
export function readBuildIdentity(location: URL): BuildIdentity {
  try {
    return parseBuildIdentity(readFileSync(location, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { sourceDigest: null, sourceCommit: null };
    throw error;
  }
}

/** This artifact's embedded identity. */
export function buildIdentity(): BuildIdentity {
  cached ??= readBuildIdentity(EMBEDDED);
  return cached;
}

/**
 * The revision public health output names: the embedded commit, else the
 * operator's DEPLOYMENT_REVISION, else a hosting platform's own commit
 * variable as a mere supplement.
 */
export function publicRevision(env: NodeJS.ProcessEnv = process.env, identity = buildIdentity()): string {
  if (identity.sourceCommit) return identity.sourceCommit.slice(0, 12);
  const configured = env.DEPLOYMENT_REVISION?.trim();
  if (configured) return configured.slice(0, 128);
  const hosted = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return hosted ? hosted.slice(0, 12) : "unknown";
}
