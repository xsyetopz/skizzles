import {
  AGENT_CONTRACT_ASSETS,
  AgentContractPackageError,
} from "./contract.ts";
import { readContainedJsonAsset } from "./filesystem/asset.ts";
import { validateIncidentCorpus } from "./incident/corpus.ts";
import type { JsonValue } from "./json/value.ts";
import { validatePinnedSchema } from "./schema/pinned.ts";

interface LoadedAsset {
  bytes: Buffer;
  value: JsonValue;
}

export async function validateCanonicalAgentContracts(
  repoRoot: string,
): Promise<void> {
  const results = await Promise.allSettled(
    AGENT_CONTRACT_ASSETS.map((asset) =>
      readContainedJsonAsset(
        repoRoot,
        asset.canonicalPath,
        `canonical ${asset.owner} ${asset.kind}`,
      ).then((loaded) => ({ asset, loaded })),
    ),
  );
  for (const result of results) {
    const { asset, loaded } = settledValue(result);
    validateAsset(asset.canonicalPath, loaded);
  }
}

export async function validateStagedAgentContracts(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const results = await Promise.all(
    AGENT_CONTRACT_ASSETS.map(async (asset) => {
      const [canonical, staged] = await Promise.allSettled([
        readContainedJsonAsset(
          repoRoot,
          asset.canonicalPath,
          `canonical ${asset.owner} ${asset.kind}`,
        ),
        readContainedJsonAsset(
          pluginRoot,
          asset.stagedPath,
          `staged ${asset.owner} ${asset.kind}`,
        ),
      ]);
      return { asset, canonical, staged };
    }),
  );
  for (const result of results) {
    const canonical = settledValue(result.canonical);
    const staged = settledValue(result.staged);
    validateAsset(result.asset.canonicalPath, canonical);
    validateAsset(result.asset.stagedPath, staged);
    if (!canonical.bytes.equals(staged.bytes)) {
      throw new AgentContractPackageError(
        `Staged ${result.asset.owner} ${result.asset.kind} diverges from its canonical owner.`,
      );
    }
  }
}

function validateAsset(path: string, asset: LoadedAsset): void {
  if (path.endsWith(".schema.json")) {
    validatePinnedSchema(path, asset.bytes);
    return;
  }
  if (path.endsWith("trust-boundary-incidents.json")) {
    validateIncidentCorpus(
      asset.value,
      "Fourth Wall incident corpus",
      "trust-boundary",
    );
    return;
  }
  if (path.endsWith("acceptance-incidents.json")) {
    validateIncidentCorpus(
      asset.value,
      "Completion Contract incident corpus",
      "acceptance",
    );
    return;
  }
  throw new AgentContractPackageError("Agent contract asset has no validator.");
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  const reason: unknown = result.reason;
  throw reason;
}
