import type { LabMetadata } from "../storage/records";
import { redactPublicText } from "./output";

export function compactLabStatus(lab: LabMetadata, stack: unknown): unknown {
  const endpoints = lab.endpoints.slice(0, 8).map((endpoint) => ({
    name: endpoint.name.slice(0, 128),
    service: endpoint.service.slice(0, 128),
    target: endpoint.target,
    url: endpoint.url.slice(0, 256),
  }));
  const findings = lab.findings.slice(0, 12).map((finding) => ({
    ...(finding.service ? { service: finding.service.slice(0, 128) } : {}),
    surface: finding.surface,
    detail: finding.detail.slice(0, 256),
  }));
  return {
    labId: lab.id,
    name: lab.name,
    state: lab.state,
    updatedAt: lab.updatedAt,
    ...(endpoints.length ? { endpoints, endpointCount: lab.endpoints.length } : {}),
    ...(findings.length ? { findings, findingCount: lab.findings.length } : {}),
    ...(lab.error ? { error: redactPublicText(lab.error, 2_000, 6) } : {}),
    ...(lab.state === "failed" && lab.provisioningFailure
      ? {
          provisioningFailure: {
            phase: lab.provisioningFailure.phase,
            capturedAt: lab.provisioningFailure.capturedAt,
            services: lab.provisioningFailure.services.slice(0, 16).map((service) => ({
              service: service.service.slice(0, 128),
              state: service.state.slice(0, 64),
              ...(service.health ? { health: service.health.slice(0, 64) } : {}),
              ...(service.exitCode === undefined ? {} : { exitCode: service.exitCode }),
            })),
            serviceCount: lab.provisioningFailure.serviceCount,
            ...(lab.provisioningFailure.evidence
              ? { evidence: { ...lab.provisioningFailure.evidence } }
              : {}),
          },
        }
      : {}),
    ...(stack ? { stack } : {}),
  };
}
