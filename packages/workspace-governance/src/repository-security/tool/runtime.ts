import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { RunWorkspace } from "@skizzles/scratchspace";
import { REPOSITORY_TOOL_ENV, runBoundedCommand } from "../process.ts";
import {
  type RepositorySecurityToolManifest,
  type SecurityToolAsset,
  type SecurityToolSpec,
  type SecurityToolTarget,
  validateArchiveMemberPath,
} from "./contract.ts";

const MAXIMUM_ARCHIVE_BYTES = 67_108_864;
const MAXIMUM_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ARCHIVE_COMMAND_TIMEOUT_MS = 30_000;
const VERSION_COMMAND_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT_BYTES = 16_384;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONTENT_LENGTH_PATTERN = /^\d+$/u;
const LINE_PATTERN = /\r?\n/u;
const TAR_EXECUTABLE = "/usr/bin/tar";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchArchive = (input: string, init: RequestInit) => Promise<Response>;

interface InstalledSecurityTools {
  actionlint: string;
  shellcheck: string;
  gitleaks: string;
}

async function installRepositorySecurityTools(
  workspace: RunWorkspace,
  manifest: RepositorySecurityToolManifest,
  target: SecurityToolTarget,
  temporaryRoot: string,
  fetchArchive: FetchArchive = fetch,
): Promise<InstalledSecurityTools> {
  const actionlint = await installSecurityTool(
    workspace,
    manifest.tools.actionlint,
    manifest.tools.actionlint.assets[target],
    temporaryRoot,
    fetchArchive,
  );
  const shellcheck = await installSecurityTool(
    workspace,
    manifest.tools.shellcheck,
    manifest.tools.shellcheck.assets[target],
    temporaryRoot,
    fetchArchive,
  );
  const gitleaks = await installSecurityTool(
    workspace,
    manifest.tools.gitleaks,
    manifest.tools.gitleaks.assets[target],
    temporaryRoot,
    fetchArchive,
  );
  return {
    actionlint,
    shellcheck,
    gitleaks,
  };
}

async function downloadVerifiedArchive(
  asset: SecurityToolAsset,
  destination: string,
  fetchArchive: FetchArchive = fetch,
  cancellation?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const abort = (): void => controller.abort(cancellation?.reason);
  cancellation?.addEventListener("abort", abort, { once: true });
  if (cancellation?.aborted === true) abort();
  let bytes: Uint8Array;
  try {
    const response = await fetchArchiveResponse(
      asset.url,
      fetchArchive,
      controller.signal,
    );
    if (!response.ok || response.body === null) {
      throw new Error(
        `security tool archive download returned HTTP ${response.status}`,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!CONTENT_LENGTH_PATTERN.test(declaredLength) ||
        Number(declaredLength) > MAXIMUM_ARCHIVE_BYTES)
    ) {
      throw new Error("security tool archive exceeds the download size limit");
    }
    bytes = await readDownload(response.body);
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new Error(`security tool archive download failed: ${reason}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    cancellation?.removeEventListener("abort", abort);
  }
  throwIfCancelled(cancellation);
  if (bytes.byteLength !== asset.githubReleaseAsset.bytes) {
    throw new Error(
      `security tool archive byte length mismatch: expected ${asset.githubReleaseAsset.bytes}, received ${bytes.byteLength}`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  throwIfCancelled(cancellation);
  if (actual !== asset.sha256) {
    throw new Error(
      `security tool archive checksum mismatch: expected ${asset.sha256}, received ${actual}`,
    );
  }
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  throwIfCancelled(cancellation);
  await chmod(destination, PRIVATE_FILE_MODE);
  throwIfCancelled(cancellation);
}

function throwIfCancelled(cancellation: AbortSignal | undefined): void {
  if (cancellation?.aborted !== true) {
    return;
  }
  if (cancellation.reason instanceof Error) {
    throw cancellation.reason;
  }
  throw new Error("security tool archive download was aborted", {
    cause: cancellation.reason,
  });
}

async function fetchArchiveResponse(
  initialUrl: string,
  fetchArchive: FetchArchive,
  signal: AbortSignal,
): Promise<Response> {
  let current = approvedDownloadUrl(initialUrl);
  const visited = new Set<string>();
  let redirects = 0;
  while (true) {
    const key = current.toString();
    if (visited.has(key)) {
      throw new Error("security tool archive redirect loop detected");
    }
    visited.add(key);
    const response = await fetchArchive(key, {
      redirect: "manual",
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    if (redirects >= MAXIMUM_REDIRECTS) {
      await response.body?.cancel();
      throw new Error("security tool archive exceeded its redirect limit");
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null || location.trim() === "") {
      throw new Error("security tool archive redirect omitted its location");
    }
    current = approvedDownloadUrl(location, current);
    redirects += 1;
  }
}

function approvedDownloadUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch (error) {
    throw new Error("security tool archive redirect URL is invalid", {
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("security tool archive redirect used an unapproved URL");
  }
  return url;
}

function validateArchiveEntries(listing: string, executablePath: string): void {
  const entries = listing.split(LINE_PATTERN).filter((entry) => entry !== "");
  let executableCount = 0;
  for (const entry of entries) {
    let normalized = entry;
    if (entry.endsWith("/")) {
      normalized = entry.slice(0, -1);
    }
    validateArchiveMemberPath(normalized, "security tool archive member");
    if (normalized === executablePath) {
      executableCount += 1;
    }
  }
  if (executableCount !== 1) {
    throw new Error(
      `security tool archive must contain executable ${executablePath} exactly once`,
    );
  }
}

async function installSecurityTool(
  workspace: RunWorkspace,
  spec: SecurityToolSpec,
  asset: SecurityToolAsset,
  temporaryRoot: string,
  fetchArchive: FetchArchive,
): Promise<string> {
  const toolRoot = join(temporaryRoot, spec.name);
  const extractionRoot = join(toolRoot, "extracted");
  const archive = join(toolRoot, "release.tar.gz");
  await mkdir(extractionRoot, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  await Promise.all([
    chmod(toolRoot, PRIVATE_DIRECTORY_MODE),
    chmod(extractionRoot, PRIVATE_DIRECTORY_MODE),
  ]);
  await downloadVerifiedArchive(asset, archive, fetchArchive, workspace.signal);

  const listing = await runBoundedCommand(
    workspace,
    TAR_EXECUTABLE,
    ["-tzf", archive],
    {
      label: `${spec.name} archive listing`,
      timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  if (listing.exitCode !== 0 || listing.stderr !== "") {
    throw new Error(`${spec.name} archive listing failed`);
  }
  validateArchiveEntries(listing.stdout, asset.executablePath);
  const detail = await runBoundedCommand(
    workspace,
    TAR_EXECUTABLE,
    ["-tvzf", archive, asset.executablePath],
    {
      label: `${spec.name} executable metadata`,
      timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  const detailLines = detail.stdout.split(LINE_PATTERN).filter(Boolean);
  if (
    detail.exitCode !== 0 ||
    detail.stderr !== "" ||
    detailLines.length !== 1 ||
    !detailLines[0]?.startsWith("-") ||
    !detailLines[0]?.endsWith(` ${asset.executablePath}`)
  ) {
    throw new Error(
      `${spec.name} executable is not one regular archive member`,
    );
  }
  const extraction = await runBoundedCommand(
    workspace,
    TAR_EXECUTABLE,
    ["-xzf", archive, "-C", extractionRoot, "--", asset.executablePath],
    {
      label: `${spec.name} archive extraction`,
      timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  if (
    extraction.exitCode !== 0 ||
    extraction.stdout !== "" ||
    extraction.stderr !== ""
  ) {
    throw new Error(`${spec.name} archive extraction failed`);
  }
  const executable = resolve(extractionRoot, asset.executablePath);
  ensureContained(extractionRoot, executable);
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${spec.name} executable must be a single regular file`);
  }
  await chmod(dirname(executable), PRIVATE_DIRECTORY_MODE);
  await chmod(executable, PRIVATE_DIRECTORY_MODE);
  ensureContained(await realpath(extractionRoot), await realpath(executable));

  const version = await runBoundedCommand(
    workspace,
    executable,
    spec.versionCommand,
    {
      label: `${spec.name} version verification`,
      timeoutMs: VERSION_COMMAND_TIMEOUT_MS,
      outputLimitBytes: VERSION_OUTPUT_LIMIT_BYTES,
      env: REPOSITORY_TOOL_ENV,
    },
  );
  if (
    version.exitCode !== 0 ||
    !new RegExp(spec.versionOutputPattern, "u").test(
      `${version.stdout}${version.stderr}`,
    )
  ) {
    throw new Error(
      `${spec.name} executable did not report pinned version ${spec.version}`,
    );
  }
  return executable;
}

async function readDownload(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAXIMUM_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(
          "security tool archive exceeds the download size limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function ensureContained(root: string, path: string): void {
  const offset = relative(root, path);
  if (offset.startsWith(`..${sep}`) || offset === "..") {
    throw new Error("security tool extraction escaped its temporary root");
  }
}

export type { FetchArchive, InstalledSecurityTools };
export {
  approvedDownloadUrl,
  downloadVerifiedArchive,
  fetchArchiveResponse,
  installRepositorySecurityTools,
  validateArchiveEntries,
};
