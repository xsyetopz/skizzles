import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileIdentity } from "../path.ts";
import type { LockOwner } from "./journal.ts";
import {
  ownerControllerIsDead,
  ownerRemainsActive,
  parsePrivateJson,
} from "./journal.ts";

const MARKER_FIELD_COUNT = 3;
const MARKER_MODE = 0o600n;
const MODE_MASK = 0o777n;
const PRIVATE_JSON_LIMIT = 16_384n;

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
    return completeRetirementMarker(claim, true, true);
  }
  if (await completeRetirementMarker(claim, false, false)) return true;
  if (await ownerRemainsActive(claim.owner)) return false;
  return completeRetirementMarker(claim, true, false);
}

async function hasValidRetirementMarker(
  claim: RetirableClaim,
): Promise<boolean> {
  const snapshot = await readMarker(retirementMarkerPath(claim.path));
  return snapshot !== undefined && markerMatches(snapshot.marker, claim);
}

async function completeRetirementMarker(
  claim: RetirableClaim,
  ownerRetired: boolean,
  allowAbsent: boolean,
): Promise<boolean> {
  const markerPath = retirementMarkerPath(claim.path);
  const temporaryPath = `${markerPath}.${claim.owner.token}.tmp`;
  const candidates = (await readdir(dirname(markerPath))).filter(
    (name) =>
      name.startsWith(`${basename(markerPath)}.`) && name.endsWith(".tmp"),
  );
  if (
    candidates.some((name) => join(dirname(markerPath), name) !== temporaryPath)
  ) {
    return false;
  }
  const markerExists = await pathEntryExists(markerPath);
  const marker = await readMarker(markerPath);
  const hasTemporary = candidates.includes(basename(temporaryPath));
  const temporary = hasTemporary ? await readMarker(temporaryPath) : undefined;
  if (marker !== undefined) {
    if (!markerMatches(marker.marker, claim)) return false;
    if (hasTemporary && temporary === undefined) return false;
    if (temporary === undefined) return true;
    if (
      !markerMatches(temporary.marker, claim) ||
      marker.identity.dev !== temporary.identity.dev ||
      marker.identity.ino !== temporary.identity.ino ||
      marker.links !== 2n ||
      temporary.links !== 2n
    ) {
      return false;
    }
    await unlink(temporaryPath);
    await syncDirectory(dirname(markerPath));
    return true;
  }
  if (markerExists) return false;
  if (temporary === undefined) {
    return ownerRetired && allowAbsent && !hasTemporary;
  }
  if (
    !ownerRetired ||
    temporary.links !== 1n ||
    !markerMatches(temporary.marker, claim)
  ) {
    return false;
  }
  try {
    await link(temporaryPath, markerPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await syncDirectory(dirname(markerPath));
  const published = await readMarker(markerPath);
  if (
    published === undefined ||
    !markerMatches(published.marker, claim) ||
    published.identity.dev !== temporary.identity.dev ||
    published.identity.ino !== temporary.identity.ino
  ) {
    return false;
  }
  await unlink(temporaryPath);
  await syncDirectory(dirname(markerPath));
  return true;
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readMarker(path: string): Promise<
  | {
      identity: FileIdentity;
      links: bigint;
      marker: RetirementMarker;
    }
  | undefined
> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    return;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      (stat.mode & MODE_MASK) !== MARKER_MODE ||
      stat.size > PRIVATE_JSON_LIMIT
    ) {
      return;
    }
    const marker = parseMarker(parsePrivateJson(await handle.readFile("utf8")));
    return {
      identity: { dev: stat.dev, ino: stat.ino },
      links: stat.nlink,
      marker,
    };
  } catch {
    return;
  } finally {
    await handle.close();
  }
}

function markerMatches(
  marker: RetirementMarker,
  claim: RetirableClaim,
): boolean {
  return (
    marker.dev === String(claim.identity.dev) &&
    marker.ino === String(claim.identity.ino) &&
    marker.token === claim.owner.token
  );
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function removeRetirementArtifacts(claim: RetirableClaim): Promise<void> {
  const marker = retirementMarkerPath(claim.path);
  const prefix = `${basename(marker)}.`;
  const hasTemporary = (await readdir(dirname(marker))).some(
    (name) => name.startsWith(prefix) && name.endsWith(".tmp"),
  );
  if (!(await pathEntryExists(marker)) && !hasTemporary) return;
  if (!(await completeRetirementMarker(claim, true, false))) {
    throw new Error("unsafe retirement artifacts");
  }
  await unlink(marker);
  await syncDirectory(dirname(marker));
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
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
