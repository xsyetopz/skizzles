import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LockOwner } from "./destination-journal.ts";
import {
  ownerControllerIsDead,
  ownerRemainsActive,
  parsePrivateJson,
} from "./destination-journal.ts";
import type { FileIdentity } from "./destination-path.ts";

const MARKER_FIELD_COUNT = 3;
const MARKER_MODE = 0o600n;
const MODE_MASK = 0o777n;

interface RetirableClaim {
  identity: FileIdentity;
  owner: LockOwner;
  path: string;
}

interface RetirementMarker {
  dev: string;
  ino: string;
  token: string;
}

const RETIREMENT_HELPER_SOURCE: string = String.raw`
import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
const text = await Bun.stdin.text();
if (text !== "") {
  const input = JSON.parse(text);
  let claim;
  try { claim = await open(input.claim, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { process.exit(0); }
  try {
    const stat = await claim.stat({ bigint: true });
    const owner = JSON.parse(await claim.readFile("utf8"));
    if (String(stat.dev) !== input.dev || String(stat.ino) !== input.ino || owner.token !== input.token) process.exit(0);
  } finally { await claim.close(); }
  const temporary = input.marker + "." + input.token + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ dev: input.dev, ino: input.ino, token: input.token }) + "\n"); await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, input.marker); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const directory = await open(dirname(input.marker), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}`;

function retirementMarkerPath(claimPath: string): string {
  return `${claimPath}.retired`;
}

async function sendRetirementBinding(
  stdin: Bun.FileSink,
  claim: RetirableClaim,
): Promise<void> {
  const payload = JSON.stringify({
    claim: claim.path,
    dev: String(claim.identity.dev),
    ino: String(claim.identity.ino),
    marker: retirementMarkerPath(claim.path),
    token: claim.owner.token,
  });
  stdin.write(payload);
  await Promise.resolve(stdin.flush());
}

async function claimRetirementConfirmed(
  claim: RetirableClaim,
): Promise<boolean> {
  if (ownerControllerIsDead(claim.owner)) {
    await ownerRemainsActive(claim.owner, 100);
    return true;
  }
  if (await hasValidRetirementMarker(claim)) return true;
  if (await ownerRemainsActive(claim.owner)) return false;
  return hasValidRetirementMarker(claim);
}

async function hasValidRetirementMarker(
  claim: RetirableClaim,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      retirementMarkerPath(claim.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || (stat.mode & MODE_MASK) !== MARKER_MODE) {
      return false;
    }
    const marker = parseMarker(parsePrivateJson(await handle.readFile("utf8")));
    return (
      marker.dev === String(claim.identity.dev) &&
      marker.ino === String(claim.identity.ino) &&
      marker.token === claim.owner.token
    );
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function removeRetirementArtifacts(claim: RetirableClaim): Promise<void> {
  const marker = retirementMarkerPath(claim.path);
  if (await hasValidRetirementMarker(claim)) {
    await unlink(marker).catch(() => undefined);
    const directory = await open(dirname(marker), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function parseMarker(value: unknown): RetirementMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid retirement marker");
  }
  const record = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(record).length !== MARKER_FIELD_COUNT ||
    typeof record["dev"] !== "string" ||
    typeof record["ino"] !== "string" ||
    typeof record["token"] !== "string"
  ) {
    throw new Error("invalid retirement marker");
  }
  return { dev: record["dev"], ino: record["ino"], token: record["token"] };
}

export {
  claimRetirementConfirmed,
  hasValidRetirementMarker,
  RETIREMENT_HELPER_SOURCE,
  removeRetirementArtifacts,
  sendRetirementBinding,
};
