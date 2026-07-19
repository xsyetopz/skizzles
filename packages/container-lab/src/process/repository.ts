import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { runLocalGit } from "./git.ts";

const SOURCE_REPOSITORY_IDENTITY_DOMAIN =
  "codex-container-lab-source-repository-v1";
const REPOSITORY_HASH_LENGTH = 12;

interface SourceRepository {
  root: string;
  repoHash: string;
  identity: string;
}

async function inspectSourceRepository(
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<SourceRepository> {
  const root = (
    await runLocalGit(
      ["-C", source, "rev-parse", "--show-toplevel"],
      { timeoutMs: 10_000 },
      environment,
    )
  ).stdout
    .toString()
    .trim();
  const commonGitDirectory = await canonicalCommonGitDirectory(
    root,
    environment,
  );
  return {
    root,
    repoHash: createHash("sha256")
      .update(commonGitDirectory)
      .digest("hex")
      .slice(0, REPOSITORY_HASH_LENGTH),
    identity: await repositoryFilesystemIdentity(commonGitDirectory),
  };
}

async function sourceRepositoryIdentity(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return await repositoryFilesystemIdentity(
    await canonicalCommonGitDirectory(repositoryRoot, environment),
  );
}

async function assertRepositoryIdentity(
  repositoryRoot: string,
  expected: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const actual = await sourceRepositoryIdentity(repositoryRoot, environment);
  if (actual !== expected) {
    throw new Error(
      "lab source repository identity no longer matches durable state",
    );
  }
}

async function assertNoGitAlternates(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const commonGitDirectory = await canonicalCommonGitDirectory(
    repositoryRoot,
    environment,
  );
  try {
    await lstat(join(commonGitDirectory, "objects", "info", "alternates"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new Error("could not verify Git alternate object-store isolation", {
      cause: error,
    });
  }
  throw new Error("Git alternate object-store isolation was not established");
}

async function canonicalCommonGitDirectory(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const commonGitDirectory = (
    await runLocalGit(
      [
        "-C",
        repositoryRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { timeoutMs: 10_000 },
      environment,
    )
  ).stdout
    .toString()
    .trim();
  return await realpath(commonGitDirectory);
}

async function repositoryFilesystemIdentity(
  commonGitDirectory: string,
): Promise<string> {
  const descriptor = await stat(commonGitDirectory, { bigint: true });
  if (!descriptor.isDirectory()) {
    throw new Error("Git common directory is not a directory");
  }
  if (
    descriptor.dev < 0n ||
    descriptor.ino <= 0n ||
    descriptor.birthtimeNs <= 0n
  ) {
    throw new Error("Git common directory has no stable filesystem identity");
  }
  return createHash("sha256")
    .update(SOURCE_REPOSITORY_IDENTITY_DOMAIN)
    .update("\0")
    .update(commonGitDirectory)
    .update("\0")
    .update(descriptor.dev.toString())
    .update("\0")
    .update(descriptor.ino.toString())
    .update("\0")
    .update(descriptor.birthtimeNs.toString())
    .digest("hex");
}

export {
  assertNoGitAlternates,
  assertRepositoryIdentity,
  inspectSourceRepository,
};
