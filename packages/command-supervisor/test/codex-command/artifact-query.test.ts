// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  artifactPath,
  encode,
  exactStatus,
  invoke,
  queryStatus,
  runner,
  spawnRunner,
  temporaryDirectory,
  text,
  waitForRunDirectory,
} from "./runner-fixture.ts";

describe("artifact query and validation", () => {
  it("serves exact status, tail, errors, and search queries from retained artifacts", () => {
    const root = temporaryDirectory();
    const run = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("printf 'alpha\\nbeta\\n'; printf 'warning marker\\n' >&2"),
      ],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root } },
    );
    const directory = artifactPath(text(run.stdout));
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const statusPath = join(directory, "status.json");

    const status = invoke(runner, ["status", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(status.exitCode).toBe(0);
    expect(text(status.stdout)).toBe(readFileSync(statusPath, "utf8"));
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);

    const stdoutTail = invoke(runner, ["tail", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(stdoutTail.stdout)).toBe("alpha\nbeta\n");

    const errors = invoke(runner, ["errors", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(errors.stdout)).toBe("warning marker\n");

    const search = invoke(runner, ["search", "marker", id], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(text(search.stdout)).toBe(`${directory}/stderr.log\n`);
  });

  it("status queries observe only complete atomic heartbeat snapshots", async () => {
    const root = temporaryDirectory();
    const longComment = "x".repeat(32 * 1024);
    const script = `# ${longComment}\nfor i in {1..160}; do printf x; sleep 0.015; done`;
    const run = spawnRunner(script, root, {
      CODEX_COMMAND_HEARTBEAT_MS: "25",
    });
    const directory = await waitForRunDirectory(root);
    const id = directory.split("/").at(-1);
    if (!id) {
      throw new Error(`run id missing from ${directory}`);
    }
    const statusPath = join(directory, "status.json");

    for (let batch = 0; batch < 20; batch += 1) {
      for (let read = 0; read < 50; read += 1) {
        exactStatus(readFileSync(statusPath, "utf8"));
      }
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => queryStatus(root, id)),
      );
      for (const response of responses) {
        expect(response.exitCode).toBe(0);
        expect(response.stderr).toBe("");
        exactStatus(response.stdout);
      }
      await Bun.sleep(5);
    }

    expect(await run.exited).toBe(0);
    exactStatus(readFileSync(statusPath, "utf8"));
    expect(readdirSync(directory).sort()).toEqual([
      "status.json",
      "stderr.log",
      "stdout.log",
    ]);
  }, 15_000);

  it("rejects malformed run IDs and query arguments without escaping the run store", () => {
    const root = temporaryDirectory();
    const cases = [
      ["status", ".."],
      ["tail", "../outside"],
      ["tail", "missing", "combined"],
      ["search", ""],
      ["search", "x".repeat(257)],
      ["run", "--base64url", "="],
      ["unknown"],
    ];
    for (const arguments_ of cases) {
      const result = invoke(runner, arguments_, {
        env: { CODEX_COMMAND_OUTPUT_DIR: root },
      });
      expect(result.exitCode, arguments_.join(" ")).toBe(64);
      expect(text(result.stderr).length, arguments_.join(" ")).toBeGreaterThan(
        0,
      );
    }
  });

  it("reports missing or malformed retained artifacts as query failures", () => {
    const root = temporaryDirectory();
    const missingStatus = join(root, "missing-status");
    mkdirSync(missingStatus, { mode: 0o700 });
    writeFileSync(join(missingStatus, "stdout.log"), "partial", {
      mode: 0o600,
    });
    const status = invoke(runner, ["status", "missing-status"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(status.exitCode).toBe(64);
    expect(text(status.stderr)).toContain("status artifact unavailable");

    const missingRun = invoke(runner, ["tail", "does-not-exist"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(missingRun.exitCode).toBe(64);
    expect(text(missingRun.stderr)).toContain("run not found: does-not-exist");

    const outside = temporaryDirectory();
    symlinkSync(outside, join(root, "linked-run"));
    const linkedRun = invoke(runner, ["tail", "linked-run"], {
      env: { CODEX_COMMAND_OUTPUT_DIR: root },
    });
    expect(linkedRun.exitCode).toBe(64);
    expect(text(linkedRun.stderr)).toContain("run not found: linked-run");
  });
});
