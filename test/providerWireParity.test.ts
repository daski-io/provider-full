import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR, FULL } from "./providerWireFixture.js";

/**
 * Offline parity of the vendored gateway provider-wire fixtures with their
 * recorded source (C07): every file the manifest lists is present byte for
 * byte, nothing else is, and the manifest itself is the recorded one. No test
 * downloads anything.
 */
const SUPPORTED_SCHEMA_VERSIONS = [1];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (name: string) => readFileSync(new URL(name, FIXTURE_DIR));
const source = JSON.parse(
  readFileSync(new URL("./fixtures/provider-wire.source.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const manifest = JSON.parse(bytes("manifest.json").toString("utf8")) as {
  schemaVersion: number;
  owner: string;
  consumers: string[];
  files: Record<string, { sha256: string; consumers: string[] }>;
};

describe("vendored provider-wire fixtures", () => {
  it("record their gateway source exactly", () => {
    expect(Object.keys(source).sort()).toEqual(["commit", "manifestSha256", "path", "repository"]);
    expect(source).toMatchObject({ repository: "daski-io/gateway", path: "test/fixtures/provider-wire" });
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(bytes("manifest.json"))).toBe(source.manifestSha256);
  });

  it("use a manifest version these tests support and name this starter", () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(manifest.schemaVersion);
    expect(manifest.owner).toBe("daski-io/gateway");
    expect(manifest.consumers).toContain(FULL);
  });

  it("hold exactly the manifest and the files it lists, each with its sha256", () => {
    const present = readdirSync(FIXTURE_DIR).sort();
    expect(present).toEqual(["manifest.json", ...Object.keys(manifest.files)].sort());
    for (const name of present) expect(statSync(new URL(name, FIXTURE_DIR)).isFile(), name).toBe(true);
    for (const [name, entry] of Object.entries(manifest.files)) {
      expect(sha256(bytes(name)), name).toBe(entry.sha256);
    }
  });

  it("are checked out without line-ending conversion", () => {
    const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
    expect(attributes).toMatch(/^test\/fixtures\/provider-wire\/\*\* -text$/m);
  });
});
