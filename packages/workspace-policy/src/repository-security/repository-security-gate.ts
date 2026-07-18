import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { runActionlintGate } from "./actionlint-gate.ts";
import { runGitleaksGate } from "./gitleaks-gate.ts";
import {
  loadRepositorySecurityToolManifest,
  resolveSecurityToolTarget,
} from "./security-tool-manifest.ts";
import { installRepositorySecurityTools } from "./security-tool-runtime.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;

async function runRepositorySecurityGate(workspaceRoot: string): Promise<void> {
  const root = resolve(workspaceRoot);
  const manifest = await loadRepositorySecurityToolManifest(root);
  const target = resolveSecurityToolTarget(process.platform, process.arch);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "skizzles-repository-security-"),
  );
  try {
    await chmod(temporaryRoot, PRIVATE_DIRECTORY_MODE);
    const tools = await installRepositorySecurityTools(
      manifest,
      target,
      temporaryRoot,
    );
    const actionlintProbes = join(temporaryRoot, "actionlint-probes");
    const gitleaksProbes = join(temporaryRoot, "gitleaks-probes");
    await Promise.all([
      mkdir(actionlintProbes, { mode: 0o700 }),
      mkdir(gitleaksProbes, { mode: 0o700 }),
    ]);
    await runActionlintGate(
      root,
      actionlintProbes,
      tools.actionlint,
      tools.shellcheck,
    );
    await runGitleaksGate(root, gitleaksProbes, tools.gitleaks);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export { runRepositorySecurityGate };
