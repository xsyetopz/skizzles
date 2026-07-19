import type { FileIdentity, Runtime } from "./platform.ts";

export interface InspectedDirectory {
  readonly identity: FileIdentity;
}

export async function inspectCanonicalDirectory(
  runtime: Runtime,
  path: string,
): Promise<InspectedDirectory | undefined> {
  const [identity, canonical] = await Promise.all([
    runtime.lstatIdentity(path),
    runtime.realpath(path).catch(() => undefined),
  ]);
  if (identity === undefined || canonical !== path) return undefined;
  return { identity };
}

export async function inspectPrivateDirectory(
  runtime: Runtime,
  path: string,
): Promise<InspectedDirectory | undefined> {
  const [inspected, privateOwner] = await Promise.all([
    inspectCanonicalDirectory(runtime, path),
    runtime.isPrivateDirectory(path),
  ]);
  if (inspected === undefined || !privateOwner) return undefined;
  return inspected;
}
