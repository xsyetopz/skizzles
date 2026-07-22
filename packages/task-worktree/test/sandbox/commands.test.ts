import { describe, expect, it } from "bun:test";
import { authorizeStructuredCommand } from "../../src/sandbox/command-policy.ts";

describe("schema-stable command policy", () => {
  it("accepts narrow read-only, build, and test profiles", () => {
    expect(
      authorizeStructuredCommand({
        profile: "read-only",
        executable: "git",
        arguments: ["status", "--short"],
        cwd: ".",
      }).status,
    ).toBe("accepted");
    expect(
      authorizeStructuredCommand({
        profile: "build",
        executable: "bun",
        arguments: ["run", "typecheck"],
        cwd: ".",
      }).status,
    ).toBe("accepted");
    expect(
      authorizeStructuredCommand({
        profile: "test",
        executable: "bun",
        arguments: ["test"],
        cwd: "packages/task-worktree",
      }).status,
    ).toBe("accepted");
  });

  it("rejects shell injection and destructive aliases", () => {
    for (const command of [
      {
        profile: "build",
        executable: "bun",
        arguments: ["run", "build; rm -rf /"],
        cwd: ".",
      },
      {
        profile: "read-only",
        executable: "git",
        arguments: ["clean", "-fdx"],
        cwd: ".",
      },
      {
        profile: "read-only",
        executable: "git",
        arguments: ["reset", "--hard"],
        cwd: ".",
      },
      {
        profile: "build",
        executable: "bun",
        arguments: ["docker", "compose", "down"],
        cwd: ".",
      },
      {
        profile: "build",
        executable: "bun",
        arguments: ["run", "$(shutdown)"],
        cwd: ".",
      },
      {
        profile: "read-only",
        executable: "git",
        arguments: ["diff", "--output=/tmp/stolen"],
        cwd: ".",
      },
      {
        profile: "test",
        executable: "bun",
        arguments: ["test", "--preload", "./untrusted.ts"],
        cwd: ".",
      },
    ]) {
      expect(authorizeStructuredCommand(command).status).toBe("rejected");
    }
  });

  it("rejects undeclared scripts, shell executables, and accessor input", () => {
    expect(
      authorizeStructuredCommand({
        profile: "build",
        executable: "bun",
        arguments: ["run", "deploy"],
        cwd: ".",
      }).status,
    ).toBe("rejected");
    expect(
      authorizeStructuredCommand({
        profile: "build",
        executable: "sh",
        arguments: ["-c", "true"],
        cwd: ".",
      }).status,
    ).toBe("rejected");
    const accessor = Object.defineProperty(
      { profile: "build", executable: "bun", cwd: "." },
      "arguments",
      { get: () => ["run", "build"] },
    );
    expect(authorizeStructuredCommand(accessor).status).toBe("rejected");
  });
});
