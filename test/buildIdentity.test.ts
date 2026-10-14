import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseBuildIdentity, publicRevision, readBuildIdentity } from "../src/core/buildIdentity.js";
// The build script embeds the identity; it is plain JavaScript run by npm run build.
// @ts-expect-error -- untyped build script
import { buildIdentity as buildTimeIdentity, sourceDigest } from "../scripts/copy-assets.mjs";

// F-T16: the artifact names its own source, computed at build time from the
// sources an image build receives; no hosting or coordinator variable is
// needed, and hosting metadata only supplements an absent identity.
const roots: string[] = [];
function sourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "build-identity-"));
  roots.push(root);
  for (const [path, content] of Object.entries({
    "package.json": "{}", "package-lock.json": "{}", "tsconfig.json": "{}", ...files,
  })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("build identity (F-T16)", () => {
  it("digests exactly the sources an image build receives", () => {
    const base = { "src/index.ts": "export {};\n", "src/services/notes/tests/notes.test.ts": "one\n" };
    const digest = sourceDigest(sourceTree(base));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sourceDigest(sourceTree(base))).toBe(digest);
    // Tests and fixtures never reach the image, so they never change it.
    expect(sourceDigest(sourceTree({ ...base, "src/services/notes/tests/notes.test.ts": "two\n" }))).toBe(digest);
    expect(sourceDigest(sourceTree({ ...base, "src/core/fixtures/sample.json": "{}" }))).toBe(digest);
    expect(sourceDigest(sourceTree({ ...base, "src/index.ts": "export const changed = 1;\n" }))).not.toBe(digest);
  });

  it("embeds a given commit and refuses a malformed one", () => {
    const root = sourceTree({ "src/index.ts": "export {};\n" });
    expect(buildTimeIdentity(root, { SOURCE_COMMIT: "ABCDEF1234" })).toMatchObject({
      schemaVersion: 1, sourceCommit: "abcdef1234",
    });
    expect(buildTimeIdentity(root, {})).toMatchObject({ sourceCommit: null });
    expect(() => buildTimeIdentity(root, { SOURCE_COMMIT: "main; rm -rf /" })).toThrow(/SOURCE_COMMIT/);
  });

  it("reads the embedded identity strictly and treats uncompiled sources as unidentified", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseBuildIdentity(JSON.stringify({ schemaVersion: 1, sourceDigest: digest, sourceCommit: "abc1234" })))
      .toEqual({ sourceDigest: digest, sourceCommit: "abc1234" });
    expect(() => parseBuildIdentity(JSON.stringify({ schemaVersion: 1, sourceDigest: "x", sourceCommit: null })))
      .toThrow(/malformed/);
    const root = sourceTree({});
    expect(readBuildIdentity(pathToFileURL(join(root, "missing.json")))).toEqual({ sourceDigest: null, sourceCommit: null });
  });

  it("names the embedded commit first and uses hosting metadata only as a supplement", () => {
    const identity = { sourceDigest: `sha256:${"b".repeat(64)}`, sourceCommit: "0123456789abcdef" };
    expect(publicRevision({ RAILWAY_GIT_COMMIT_SHA: "ffffffffffff" }, identity)).toBe("0123456789ab");
    const none = { sourceDigest: null, sourceCommit: null };
    expect(publicRevision({ DEPLOYMENT_REVISION: "v1.0.0-rc1", RAILWAY_GIT_COMMIT_SHA: "ffff" }, none)).toBe("v1.0.0-rc1");
    expect(publicRevision({ RAILWAY_GIT_COMMIT_SHA: "fedcba9876543210" }, none)).toBe("fedcba987654");
    expect(publicRevision({}, none)).toBe("unknown");
  });
});
