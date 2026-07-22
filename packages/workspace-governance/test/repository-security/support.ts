import { mkdir } from "node:fs/promises";
import { create, type RunWorkspace } from "@skizzles/scratchspace";

export function createSecurityFixtureScope() {
  let active: Promise<RunWorkspace> | undefined;

  async function workspace(): Promise<RunWorkspace> {
    active ??= create();
    return await active;
  }

  async function directory(label: string): Promise<string> {
    const runWorkspace = await workspace();
    const root = runWorkspace.path(
      "fixtures",
      `${label}-${crypto.randomUUID()}`,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  async function cleanup(): Promise<void> {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    const report = await (await current).close();
    if (report.state === "cleanup-failed") {
      throw new Error("repository security fixture cleanup failed");
    }
  }

  return { cleanup, directory, workspace };
}
