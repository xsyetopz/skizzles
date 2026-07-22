import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliFixtureScope,
  join,
  mkdtemp,
  parsePublishedPid,
  process,
  serializePublicJson,
  tmpdir,
  waitForPublishedPid,
  writeFile,
} from "./support.ts";

const fixtures = createCliFixtureScope();
const { trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

describe("CLI argument and serialization validation", () => {
  it("reports the package version without requiring an owner", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--version",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "" },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ version: "0.1.0" });
  });

  it("does not treat an empty PID publication as ready", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "container-lab-pid-publication-"),
    );
    trackTemporaryPath(root);
    const pidPath = join(root, "run.pid");
    await writeFile(pidPath, "");

    const pending = waitForPublishedPid(pidPath);
    expect(
      await Promise.race([
        pending.then(() => "resolved"),
        Bun.sleep(25).then(() => "waiting"),
      ]),
    ).toBe("waiting");

    await writeFile(pidPath, "12345");
    await expect(pending).resolves.toBe(12_345);
  });

  it("accepts only canonical positive safe-integer PID publications", () => {
    for (const text of [
      "",
      " ",
      "0",
      "-1",
      "+1",
      "01",
      "1.5",
      "123x",
      "123\n",
      "9007199254740992",
    ]) {
      expect(parsePublishedPid(text)).toBeUndefined();
    }

    expect(parsePublishedPid("1")).toBe(1);
    expect(parsePublishedPid("9007199254740991")).toBe(9_007_199_254_740_991);
  });

  it("real public serialization clips worst-case escaped transcripts to 16 KiB", () => {
    const encoded = serializePublicJson({
      labId: "lab-1",
      service: "dev",
      transcript: {
        text: '\\"'.repeat(8 * 1024),
        bytes: 16 * 1024,
        lines: 1,
        truncated: false,
      },
    });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(encoded);
    expect(parsed.transcript.truncated).toBe(true);
    expect(parsed.transcript.bytes).toBeLessThanOrEqual(8 * 1024);
  });
});
