import { resolve } from "node:path";
import process from "node:process";
import { runRepositorySecurityGate } from "./repository-security/gate.ts";

async function main(args: readonly string[]): Promise<0 | 1> {
  const root = resolve(args[0] ?? process.cwd());
  try {
    await runRepositorySecurityGate(root);
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
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}

export { main };
