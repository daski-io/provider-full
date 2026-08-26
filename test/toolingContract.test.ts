import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: 15_000,
  });
}

describe("starter tooling contracts", () => {
  it.each([
    ["echo", "echo_result"],
    ["create-note", "note_created"],
  ])("runs the tracked dummy %s request entirely offline", (skillId, artifactName) => {
    const run = runNode([
      "--import=tsx",
      "scripts/try-skill.mjs",
      "dummy",
      skillId,
    ]);

    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout) as {
      mode: string;
      inputSource: string;
      warning: string;
      result: { artifacts: Array<{ name: string }> };
    };
    expect(output.mode).toBe("offline-dummy-only");
    expect(output.inputSource).toBe(`examples/requests/dummy-${skillId}.json`);
    expect(output.warning).toContain("No gateway admission");
    expect(output.result.artifacts.map((artifact) => artifact.name)).toContain(artifactName);
  });

  it("keeps documentation machine-validatable", () => {
    const docs = runNode(["scripts/docs-check.mjs"]);

    expect(docs.status, docs.stderr).toBe(0);
    expect(docs.stdout).toContain("documentation checks passed");
  });
});
