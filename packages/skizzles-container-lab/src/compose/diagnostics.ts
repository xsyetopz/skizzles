import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactPublicText } from "../public/output";
import type { CommandResult } from "../execution/process";
import type { ProvisioningFailureDiagnostic } from "../storage/records";
import { scrubSecretEnvironment, type DockerRunner } from "./docker-runner";
import { composeCommand } from "./compose-command";
import { listStackServiceSummaries, type ServiceSummary } from "./status";
import type { LabRuntime } from "./runtime-model";

/** The only durable path used for a failed Compose-up transcript. */
export const PROVISIONING_FAILURE_DIAGNOSTIC_FILE = "provisioning-failure.compose-up.log";

export class DockerProvisioningFailure extends Error {
  constructor(message: string, readonly diagnostic: ProvisioningFailureDiagnostic) {
    super(message);
    this.name = "DockerProvisioningFailure";
  }
}

export async function captureComposeFailure(
  runtime: LabRuntime,
  provisioned: CommandResult | undefined,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<ProvisioningFailureDiagnostic> {
  const capturedAt = new Date().toISOString();
  let services: ProvisioningFailureDiagnostic["services"] = [];
  let serviceCount = 0;
  let candidates: string[] = [];
  let allServices: ServiceSummary[] = [];
  try {
    const status = await listStackServiceSummaries(runtime, runner, environment, true);
    if (status.available) {
      allServices = status.services;
      services = allServices.slice(0, 16);
      serviceCount = status.serviceCount;
      candidates = selectFailedDiagnosticServices(runtime, allServices);
    }
  } catch {
    // Capturing diagnostics is deliberately best effort. The original
    // Compose failure remains authoritative when Docker is unavailable.
  }

  const raw = provisioned === undefined
    ? ""
    : [provisioned.stdout.toString(), provisioned.stderr.toString()].filter((part) => part.length > 0).join("\n");
  const secretValues = declaredSecretValues(runtime, environment);
  const lifecycleBytes = candidates.length > 0 ? 2_048 - 1 : 8 * 1024;
  const lifecycleLines = candidates.length > 0 ? 125 : 500;
  const lifecycle = buildDiagnosticSegment(
    "compose-up",
    raw,
    runtime,
    secretValues,
    lifecycleLines,
    lifecycleBytes,
    provisioned?.stdoutTruncated === true || provisioned?.stderrTruncated === true,
  );
  const serviceBytes = divideDiagnosticBudget(6 * 1024 - Math.max(0, candidates.length - 1), candidates.length);
  const serviceLines = divideDiagnosticBudget(375, candidates.length);
  const segments = [lifecycle];
  for (const [index, service] of candidates.entries()) {
    const captured = await captureFailedServiceLogs(
      runtime,
      service,
      Math.max(1, (serviceLines[index] ?? 1) - 1),
      Math.max(1, serviceBytes[index] ?? 1),
      runner,
      environment,
    );
    segments.push(buildDiagnosticSegment(
      `service:${service}`,
      captured.raw,
      runtime,
      secretValues,
      serviceLines[index] ?? 1,
      serviceBytes[index] ?? 1,
      captured.truncated,
    ));
  }
  const aggregate = joinDiagnosticSegments(segments);
  let transcript = aggregate.text;
  let transcriptTruncated = segments.some((segment) => segment.truncated);
  const privacyFailure = segments.some((segment) => segment.privacyFailure) ||
    aggregateContainsSecret(transcript, aggregate.bodyRanges, secretValues);
  const aggregateBounds = Buffer.byteLength(transcript) > 8 * 1024 || transcript.split("\n").length > 500;
  if (privacyFailure || aggregateBounds) {
    transcript = "";
    transcriptTruncated ||= aggregateBounds;
  }
  const evidence = {
    kind: "compose-up" as const,
    available: false,
    bytes: 0,
    lines: 0,
    truncated: transcriptTruncated,
  };
  try {
    await writeFailureTranscript(runtime.metadata.runtimeRoot, transcript);
    evidence.available = true;
    evidence.bytes = Buffer.byteLength(transcript);
    evidence.lines = transcript ? transcript.split("\n").length : 0;
  } catch {
    // A transcript write must never mask the exact Compose error or block
    // label-scoped cleanup in the service failure path.
  }
  return {
    phase: "compose-up",
    capturedAt,
    services,
    serviceCount,
    evidence,
  };
}

function selectFailedDiagnosticServices(runtime: LabRuntime, services: readonly ServiceSummary[]): string[] {
  const candidates = [...new Set([
    runtime.config.mode.commandService,
    ...runtime.config.ports.map((port) => port.service),
  ])];
  return candidates.filter((candidate) => services.some((summary) => {
    if (summary.service !== candidate) return false;
    const failedExit = summary.state.toLowerCase() === "exited" && summary.exitCode !== undefined && summary.exitCode !== 0;
    return failedExit || summary.health?.toLowerCase() === "unhealthy";
  })).slice(0, 4);
}

function divideDiagnosticBudget(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

async function captureFailedServiceLogs(
  runtime: LabRuntime,
  service: string,
  tailLines: number,
  segmentBytes: number,
  runner: DockerRunner,
  environment: NodeJS.ProcessEnv,
): Promise<{ raw: string; truncated: boolean }> {
  const headerBytes = Buffer.byteLength(`--- service:${service} ---`);
  const bodyBytes = Math.max(0, segmentBytes - headerBytes - 1);
  const streamBytes = Math.floor(Math.max(0, bodyBytes - 1) / 2);
  let result: CommandResult;
  try {
    result = await runner.run([...runtime.composeArgs, "logs", "--no-color", "--no-log-prefix", "--tail", String(tailLines), service], {
      allowFailure: true,
      timeoutMs: 20_000,
      maxOutputBytes: streamBytes,
      stdoutCapture: "tail",
      stderrCapture: "tail",
      env: scrubSecretEnvironment(runtime.config.secretEnvironment, environment),
    });
  } catch {
    return { raw: "", truncated: true };
  }
  return {
    raw: [result.stdout.toString(), result.stderr.toString()].filter((part) => part.length > 0).join("\n"),
    truncated: result.code !== 0 || result.stdoutTruncated === true || result.stderrTruncated === true,
  };
}

function buildDiagnosticSegment(
  label: string,
  raw: string,
  runtime: LabRuntime,
  secretValues: readonly string[],
  maxLines: number,
  maxBytes: number,
  upstreamTruncated: boolean,
): DiagnosticSegment {
  // Treat captured Compose output as untrusted until it has been redacted,
  // bounded, control-sanitized, and checked. The synthetic label is trusted
  // framing and is added only after that body pipeline completes.
  const header = `--- ${label} ---`;
  const body = boundedDiagnosticTail(
    redactComposeFailure(raw, runtime, secretValues),
    Math.max(0, maxLines - 1),
    Math.max(0, maxBytes - Buffer.byteLength(header) - 1),
  );
  const privacyFailure = bodyContainsSecret(body.text, header, secretValues);
  const text = body.text ? `${header}\n${body.text}` : header;
  return {
    text: privacyFailure ? "" : text,
    truncated: upstreamTruncated || body.truncated,
    privacyFailure,
    bodyStart: body.text ? header.length + 1 : undefined,
    bodyEnd: body.text ? text.length : undefined,
  };
}

type DiagnosticSegment = {
  text: string;
  truncated: boolean;
  privacyFailure: boolean;
  bodyStart?: number;
  bodyEnd?: number;
};

type DiagnosticBodyRange = { start: number; end: number };

function joinDiagnosticSegments(segments: readonly DiagnosticSegment[]): {
  text: string;
  bodyRanges: DiagnosticBodyRange[];
} {
  let text = "";
  const bodyRanges: DiagnosticBodyRange[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const separator = text ? "\n" : "";
    const offset = text.length + separator.length;
    text += `${separator}${segment.text}`;
    if (segment.bodyStart !== undefined && segment.bodyEnd !== undefined && segment.bodyStart < segment.bodyEnd) {
      bodyRanges.push({
        start: offset + segment.bodyStart,
        end: Math.min(offset + segment.bodyEnd, text.length),
      });
    }
  }
  return { text, bodyRanges };
}

function aggregateContainsSecret(
  text: string,
  bodyRanges: readonly DiagnosticBodyRange[],
  secretValues: readonly string[],
): boolean {
  return secretValues.some((secret) => {
    if (!secret) return false;
    let start = text.indexOf(secret);
    while (start >= 0) {
      const end = start + secret.length;
      if (bodyRanges.some((range) => start < range.end && end > range.start)) return true;
      start = text.indexOf(secret, start + 1);
    }
    return false;
  });
}

function bodyContainsSecret(body: string, header: string, secretValues: readonly string[]): boolean {
  // Ignore occurrences wholly in trusted framing (including its separator),
  // but fail closed when a value crosses into any untrusted body code unit.
  if (!body) return false;
  const framed = `${header}\n${body}`;
  const bodyStart = header.length + 1;
  return secretValues.some((secret) => {
    let start = framed.indexOf(secret);
    while (start >= 0) {
      if (start + secret.length > bodyStart) return true;
      start = framed.indexOf(secret, start + 1);
    }
    return false;
  });
}

async function writeFailureTranscript(runtimeRoot: string, text: string): Promise<void> {
  const root = await lstat(runtimeRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("invalid lab runtime root");
  }
  const destination = join(runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function redactComposeFailure(value: string, runtime: LabRuntime, secretValues: readonly string[]): string {
  let diagnostic = value;
  for (const secret of secretValues) {
    diagnostic = diagnostic.split(secret).join("[secret-value-redacted]");
  }
  const metadata = [
    runtime.metadata.owner,
    runtime.metadata.ownerKey,
    runtime.metadata.id,
    runtime.metadata.composeProject,
    runtime.metadata.sourceRoot,
    runtime.metadata.manifestPath,
    runtime.metadata.runtimeRoot,
    runtime.metadata.workspace,
    ...runtime.composeArgs,
  ];
  for (const value of metadata) {
    if (value) diagnostic = diagnostic.split(value).join("[redacted]");
  }
  // Compose may print short container ids that are not covered by the public
  // text redactor's UUID/sha256 rules. They are not useful at this boundary.
  diagnostic = diagnostic.replace(/\b[0-9a-f]{12,64}\b/gi, "[redacted]");
  return redactPublicText(diagnostic, 8 * 1024, 500, { byteCapture: "tail" });
}

function declaredSecretValues(runtime: LabRuntime, environment: NodeJS.ProcessEnv): string[] {
  return [...new Set(runtime.config.secretEnvironment
    .map((name) => environment[name])
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function boundedDiagnosticTail(value: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�").trimEnd();
  const lines = sanitized.split("\n");
  let selected = lines.slice(-maxLines).join("\n");
  let truncated = lines.length > maxLines;
  let bytes = Buffer.from(selected);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(bytes.byteLength - maxBytes);
    selected = bytes.toString("utf8").replace(/^�/, "");
    truncated = true;
  }
  return { text: selected, truncated };
}
