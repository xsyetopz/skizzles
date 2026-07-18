import { join } from "node:path";
import { sha256, validateText } from "../content-integrity.ts";
import {
  assertKeys,
  numberValue,
  record,
  stringValue,
} from "../json-contract.ts";
import type { FileFact, PromptManifest } from "../lifecycle-contract.ts";
import {
  BASELINE_PATH,
  LICENSE_PATH,
  MANIFEST_PATH,
  NOTICE_PATH,
  OFFICIAL_REPOSITORY,
  OUTPUT_PATH,
  PATCH_PATH,
  PROMPT_SCHEMA,
  PROMPT_SCHEMA_VERSION,
  PROVENANCE_PATH,
  PromptLayerError,
  UPSTREAM_PATH,
} from "../lifecycle-contract.ts";
import { errorMessage, readRequiredFile } from "../repository-boundary.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MACHINE_PATH =
  /(?:\/Users\/[A-Za-z0-9._-]+(?:\/|\b)|\/home\/[A-Za-z0-9._-]+(?:\/|\b)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b))/i;
const PROVENANCE_MARKER = "Skizzles prompt layer provenance";
const PROVENANCE_FIELD =
  /^[\t ]*(?:Repository|Commit|Path|Baseline role):[\t ]*/m;

export async function readManifest(root: string): Promise<PromptManifest> {
  const bytes = await readRequiredFile(
    join(root, MANIFEST_PATH),
    "prompt manifest",
  );
  validateText(bytes, "prompt manifest");
  rejectMachinePaths(bytes, "prompt manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt manifest is invalid JSON: ${errorMessage(error)}`,
    );
  }
  const object = record(parsed, "prompt manifest");
  assertKeys(
    object,
    ["schema", "version", "upstream", "patch", "output", "provenance"],
    "prompt manifest",
  );
  const upstream = record(object["upstream"], "manifest upstream");
  assertKeys(
    upstream,
    ["repository", "commit", "path", "baseline", "license", "notice"],
    "manifest upstream",
  );
  const provenance = record(object["provenance"], "manifest provenance");
  assertKeys(provenance, ["path"], "manifest provenance");
  const manifest: PromptManifest = {
    schema: stringValue(object["schema"], "schema"),
    version: numberValue(object["version"], "version"),
    upstream: {
      repository: stringValue(upstream["repository"], "upstream repository"),
      commit: stringValue(upstream["commit"], "upstream commit"),
      path: stringValue(upstream["path"], "upstream path"),
      baseline: fileFactValue(upstream["baseline"], "baseline", BASELINE_PATH),
      license: fileFactValue(upstream["license"], "LICENSE", LICENSE_PATH),
      notice: fileFactValue(upstream["notice"], "NOTICE", NOTICE_PATH),
    },
    patch: fileFactValue(object["patch"], "patch", PATCH_PATH),
    output: fileFactValue(object["output"], "output", OUTPUT_PATH),
    provenance: {
      path: stringValue(provenance["path"], "provenance path"),
    },
  };
  if (
    manifest.schema !== PROMPT_SCHEMA ||
    manifest.version !== PROMPT_SCHEMA_VERSION
  ) {
    throw new PromptLayerError(
      "Unsupported prompt manifest schema or version.",
    );
  }
  if (
    manifest.upstream.repository !== OFFICIAL_REPOSITORY ||
    manifest.upstream.path !== UPSTREAM_PATH ||
    manifest.provenance.path !== PROVENANCE_PATH ||
    !COMMIT.test(manifest.upstream.commit)
  ) {
    throw new PromptLayerError(
      "Prompt manifest contains an invalid ref or path.",
    );
  }
  return manifest;
}

function fileFactValue(
  value: unknown,
  label: string,
  expectedPath: string,
): FileFact {
  const object = record(value, `${label} fact`);
  assertKeys(object, ["path", "sha256", "bytes"], `${label} fact`);
  const fact = {
    path: stringValue(object["path"], `${label} path`),
    sha256: stringValue(object["sha256"], `${label} sha256`),
    bytes: numberValue(object["bytes"], `${label} bytes`),
  };
  if (
    fact.path !== expectedPath ||
    !SHA256.test(fact.sha256) ||
    !Number.isSafeInteger(fact.bytes) ||
    fact.bytes < 1
  ) {
    throw new PromptLayerError(`Prompt manifest has an invalid ${label} fact.`);
  }
  return fact;
}

export async function verifiedFile(
  root: string,
  fact: FileFact,
  label: string,
): Promise<Buffer> {
  const bytes = await readRequiredFile(join(root, fact.path), label);
  validateText(bytes, label);
  verifyFact(bytes, fact, label);
  return bytes;
}

export function verifyFact(bytes: Buffer, fact: FileFact, label: string): void {
  if (bytes.byteLength !== fact.bytes || sha256(bytes) !== fact.sha256) {
    throw new PromptLayerError(
      `${label} does not match its pinned digest and byte count.`,
    );
  }
}

export function provenanceBytes(manifest: PromptManifest): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: PROMPT_SCHEMA,
        version: PROMPT_SCHEMA_VERSION,
        baselineRole:
          "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline",
        upstream: {
          repository: manifest.upstream.repository,
          commit: manifest.upstream.commit,
          path: manifest.upstream.path,
          sha256: manifest.upstream.baseline.sha256,
          bytes: manifest.upstream.baseline.bytes,
        },
        patch: {
          sha256: manifest.patch.sha256,
          bytes: manifest.patch.bytes,
        },
        output: {
          sha256: manifest.output.sha256,
          bytes: manifest.output.bytes,
        },
        legal: {
          license: {
            sha256: manifest.upstream.license.sha256,
            bytes: manifest.upstream.license.bytes,
          },
          notice: {
            sha256: manifest.upstream.notice.sha256,
            bytes: manifest.upstream.notice.bytes,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function manifestBytes(manifest: PromptManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function fileFact(path: string, bytes: Buffer): FileFact {
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

export function rejectMachinePaths(bytes: Buffer, label: string): void {
  if (MACHINE_PATH.test(bytes.toString("utf8"))) {
    throw new PromptLayerError(`${label} contains a machine-specific path.`);
  }
}

export function validateOutputProvenance(
  output: Buffer,
  commit: string,
  upstreamPath: string,
): void {
  const text = output.toString("utf8");
  const header = canonicalProvenanceHeader(commit, upstreamPath);
  if (!text.startsWith(header)) {
    throw new PromptLayerError(
      "Applied prompt must begin at byte zero with the exact canonical generic-baseline provenance header.",
    );
  }
  if (text.split(PROVENANCE_MARKER).length !== 2) {
    throw new PromptLayerError(
      "Applied prompt contains duplicate or contradictory provenance claims.",
    );
  }
  if (PROVENANCE_FIELD.test(text.slice(header.length))) {
    throw new PromptLayerError(
      "Applied prompt contains a later hidden provenance claim.",
    );
  }
}

function canonicalProvenanceHeader(
  commit: string,
  upstreamPath: string,
): string {
  return `<!--\n${PROVENANCE_MARKER}\nRepository: ${OFFICIAL_REPOSITORY}\nCommit: ${commit}\nPath: ${upstreamPath}\nBaseline role: pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline\n-->\n\n`;
}

export async function compareGenerated(
  path: string,
  expected: Buffer,
  label: string,
): Promise<void> {
  const actual = await readRequiredFile(path, label);
  if (!actual.equals(expected)) {
    throw new PromptLayerError(
      `${label} diverges from the checksum-locked prompt layer; run \`bun run prompt:build\`.`,
    );
  }
}
