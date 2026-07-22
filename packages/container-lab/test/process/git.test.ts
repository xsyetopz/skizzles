import { expect, it } from "bun:test";
import { gitProcessEnvironment, runLocalGit } from "../../src/process/git.ts";

it("Git process environment excludes ambient repository and credential controls", () => {
  const ambient = {
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp/exact",
    HOME: "/private/home",
    GIT_DIR: "/attacker/repository",
    GIT_WORK_TREE: "/attacker/worktree",
    GIT_INDEX_FILE: "/attacker/index",
    GIT_OBJECT_DIRECTORY: "/attacker/objects",
    GIT_ASKPASS: "/attacker/askpass",
    GIT_SSH_COMMAND: "attacker-ssh",
    GIT_CREDENTIAL_HELPER: "attacker-helper",
    GIT_TRACE: "1",
    GIT_PAGER: "attacker-pager",
    GIT_EDITOR: "attacker-editor",
  };

  expect(gitProcessEnvironment(ambient)).toEqual({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp/exact",
  });
  expect(ambient.GIT_DIR).toBe("/attacker/repository");
});

it("Git adapter rejects non-local clone sources before spawn", async () => {
  await expect(
    runLocalGit(
      ["clone", "https://example.invalid/repository.git", "/tmp/destination"],
      {},
      { PATH: "/usr/bin:/bin" },
    ),
  ).rejects.toThrow("requires absolute local source and destination");
});
