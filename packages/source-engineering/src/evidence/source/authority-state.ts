import type {
  SourceCaptureAuthorityPort,
  SourceCaptureReceipt,
  SourceEvidenceLanguage,
  TemplateAuthorityPort,
  TemplateEvidenceReceipt,
} from "./contract.ts";

export interface TemplateRegistration {
  readonly id: string;
  readonly language: SourceEvidenceLanguage;
}

export interface ParsedConfig {
  readonly sourceCapture: SourceCaptureAuthorityPort["capture"];
  readonly materializeTemplate: TemplateAuthorityPort["materialize"];
  readonly templates: ReadonlyMap<string, TemplateRegistration>;
}

export interface SourceBindings {
  readonly requestDigest: string;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: string;
  readonly configDigest: string;
  readonly path: string;
  readonly language: SourceEvidenceLanguage;
}

export interface CapturedRecord {
  readonly receipt: SourceCaptureReceipt;
  readonly baselineBytes: readonly number[];
}

export interface TemplateRecord {
  readonly receipt: TemplateEvidenceReceipt;
  readonly nodeSource: string;
}

export interface DataRecord extends Record<string, unknown> {
  sourceCaptureAuthority?: unknown;
  templateAuthority?: unknown;
  templates?: unknown;
  capture?: unknown;
  materialize?: unknown;
  id?: unknown;
  language?: unknown;
  requestDigest?: unknown;
  repositoryId?: unknown;
  rootIdentity?: unknown;
  treeDigest?: unknown;
  configDigest?: unknown;
  path?: unknown;
  baselineDigest?: unknown;
  baselineBytes?: unknown;
  templateId?: unknown;
  nodeSource?: unknown;
  templateDigest?: unknown;
  tool?: unknown;
  toolVersion?: unknown;
  contentDigest?: unknown;
  schemaDigest?: unknown;
  nodeSourceDigest?: unknown;
}
