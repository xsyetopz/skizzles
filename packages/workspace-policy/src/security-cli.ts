import { resolve } from "node:path";
import process from "node:process";
import { RunWorkspaceAbortedError } from "@skizzles/run-workspace";
import { runRepositorySecurityGate } from "./repository-security/gate.ts";

type SecurityExitCode = 0 | 1 | 129 | 130 | 143;
type SecurityGate = (root: string) => Promise<void>;

async function main(
  args: readonly string[],
  gate: SecurityGate = runRepositorySecurityGate,
): Promise<SecurityExitCode> {
  const root = resolve(args[0] ?? process.cwd());
  try {
    await gate(root);
    process.stdout.write(
      "Repository security gate passed: actionlint 1.7.12 with ShellCheck 0.11.0; Gitleaks 8.30.1 tree/history scans.\n",
    );
    return 0;
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    process.stderr.write(`Repository security gate failed: ${reason}\n`);
    if (error instanceof RunWorkspaceAbortedError) {
      if (error.signal === "SIGHUP") return 129;
      if (error.signal === "SIGINT") return 130;
      if (error.signal === "SIGTERM") return 143;
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}

export { main };
