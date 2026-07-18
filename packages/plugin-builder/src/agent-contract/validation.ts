import {
  AGENT_CONTRACT_ASSETS,
  AgentContractPackageError,
  CORPUS_CASES,
  canonicalAssetPath,
  SCHEMA_IDS,
  stagedAssetPath,
} from "./contract.ts";
import { validateIncidentCorpus } from "./corpus.ts";
import { validateSchemaDocument } from "./json-schema.ts";
import { readJsonAsset } from "./json-value.ts";
import { validateSchemaSemantics } from "./schema-contract.ts";

const SCHEMA_EXPECTATIONS = {
  "skills/completion-contract/contracts/acceptance.schema.json": {
    id: SCHEMA_IDS.acceptance,
    requiredRootProperties: [
      "schemaVersion",
      "requirements",
      "objectiveGates",
      "evaluationOrder",
      "artifacts",
      "evidence",
      "execution",
      "judge",
      "authors",
    ],
    requiredSemanticPaths: [
      "properties.objectiveGates.items.properties.order",
      "properties.evaluationOrder",
      "properties.artifacts.items.properties.sha256",
      "properties.evidence.items.properties.kind",
      "properties.execution.properties.retries",
      "properties.execution.properties.seed",
      "properties.judge.properties.version",
      "properties.judge.properties.promptSha256",
      "properties.authors.properties.selfReview",
    ],
  },
  "skills/fourth-wall/contracts/context-envelope.schema.json": {
    id: SCHEMA_IDS.contextEnvelope,
    requiredRootProperties: ["schemaVersion", "contextId", "properties"],
    requiredSemanticPaths: [
      "$defs.contextProperty.properties.origin",
      "$defs.contextProperty.properties.createdAt",
      "$defs.contextProperty.properties.trustClass",
      "$defs.contextProperty.properties.integrity.properties.sha256",
      "$defs.contextProperty.properties.scope",
      "$defs.contextProperty.properties.objective",
      "$defs.contextProperty.properties.policyVersion",
      "$defs.contextProperty.properties.retention.properties.expiresAt",
      "$defs.contextProperty.properties.sensitivity",
      "$defs.contextProperty.properties.redaction",
      "$defs.contextProperty.properties.transformations.items.properties.producer",
      "$defs.contextProperty.properties.validation.properties.property",
      "$defs.contextProperty.properties.validation.properties.status",
      "$defs.contextProperty.properties.validation.properties.validator",
      "$defs.contextProperty.properties.validation.properties.evidence",
    ],
  },
  "skills/fourth-wall/contracts/handoff-review.schema.json": {
    id: SCHEMA_IDS.handoffReview,
    requiredRootProperties: [
      "schemaVersion",
      "createdAt",
      "expiresAt",
      "objective",
      "inputs",
      "artifacts",
      "acceptance",
      "policy",
      "authors",
      "evidence",
    ],
    requiredSemanticPaths: [
      "properties.objective.properties.version",
      "properties.objective.properties.digest",
      "properties.inputs.items",
      "properties.artifacts.items",
      "$defs.integrityReference.properties.sha256",
      "properties.acceptance.properties.version",
      "properties.acceptance.properties.digest",
      "properties.policy.properties.version",
      "properties.policy.properties.digest",
      "properties.policy.properties.modelVersion",
      "properties.policy.properties.modelDigest",
      "properties.authors.properties.selfReview",
      "properties.evidence.items.properties.ref",
    ],
  },
} as const;

export async function validateCanonicalAgentContracts(
  repoRoot: string,
): Promise<void> {
  const parsedAssets = await Promise.allSettled(
    AGENT_CONTRACT_ASSETS.map((asset) => {
      const label = `canonical ${asset.owner} ${asset.kind} ${asset.canonicalPath}`;
      return readJsonAsset(canonicalAssetPath(repoRoot, asset), label).then(
        (parsed) => ({ asset, label, parsed }),
      );
    }),
  );
  for (const result of parsedAssets) {
    const { asset, label, parsed } = settledValue(result);
    validateAsset(asset.canonicalPath, parsed.value, label);
  }
}

export async function validateStagedAgentContracts(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const parsedAssets = await Promise.all(
    AGENT_CONTRACT_ASSETS.map(async (asset) => {
      const canonicalLabel = `canonical ${asset.owner} ${asset.kind} ${asset.canonicalPath}`;
      const stagedLabel = `staged ${asset.owner} ${asset.kind} ${asset.stagedPath}`;
      const [canonical, staged] = await Promise.allSettled([
        readJsonAsset(canonicalAssetPath(repoRoot, asset), canonicalLabel),
        readJsonAsset(stagedAssetPath(pluginRoot, asset), stagedLabel),
      ]);
      return { asset, canonical, canonicalLabel, staged, stagedLabel };
    }),
  );
  for (const result of parsedAssets) {
    const { asset, canonicalLabel, stagedLabel } = result;
    const canonical = settledValue(result.canonical);
    const staged = settledValue(result.staged);
    validateAsset(asset.canonicalPath, canonical.value, canonicalLabel);
    validateAsset(asset.stagedPath, staged.value, stagedLabel);
    if (!canonical.bytes.equals(staged.bytes)) {
      throw new AgentContractPackageError(
        `${stagedLabel} diverges from its canonical owner.`,
      );
    }
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  const reason: unknown = result.reason;
  throw reason;
}

function validateAsset(
  path: string,
  value: Parameters<typeof validateSchemaDocument>[0],
  label: string,
): void {
  if (path.endsWith(".schema.json")) {
    const expectation =
      SCHEMA_EXPECTATIONS[path as keyof typeof SCHEMA_EXPECTATIONS];
    if (expectation === undefined) {
      throw new AgentContractPackageError(
        `${label} has no schema composition contract.`,
      );
    }
    validateSchemaDocument(value, label, expectation);
    validateSchemaSemantics(path, value, label);
    return;
  }
  if (path.endsWith("trust-boundary-incidents.json")) {
    validateIncidentCorpus(value, label, CORPUS_CASES.trustBoundary);
    return;
  }
  if (path.endsWith("acceptance-incidents.json")) {
    validateIncidentCorpus(value, label, CORPUS_CASES.acceptance);
    return;
  }
  throw new AgentContractPackageError(`${label} has no asset validator.`);
}
