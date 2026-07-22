import { expect, it } from "bun:test";
import { resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dir, "..");

it("the package facade imports without executing the stdin hook", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'const module = await import("@skizzles/command-hook"); if (typeof module.isManagedScript !== "function") throw new Error("missing package facade");',
    ],
    {
      cwd: packageRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = Bun.sleep(1000).then(() => "deadline" as const);
  const outcome = await Promise.race([child.exited, deadline]);
  if (outcome === "deadline") {
    child.kill("SIGKILL");
  }
  child.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(outcome).not.toBe("deadline");
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});
