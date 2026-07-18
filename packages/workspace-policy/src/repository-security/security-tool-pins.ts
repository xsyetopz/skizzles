import type {
  SecurityToolName,
  SecurityToolTarget,
} from "./security-tool-contract.ts";

interface RequiredAssetFacts {
  assetId: number;
  bytes: number;
  updatedAt: string;
}

interface RequiredToolFacts {
  version: string;
  license: string;
  repository: string;
  tag: string;
  commit: string;
  releaseId: number;
  assets: Readonly<Record<SecurityToolTarget, RequiredAssetFacts>>;
}

const REQUIRED_TOOL_FACTS: Readonly<
  Record<SecurityToolName, RequiredToolFacts>
> = {
  actionlint: {
    version: "1.7.12",
    license: "MIT",
    repository: "rhysd/actionlint",
    tag: "v1.7.12",
    // biome-ignore lint/security/noSecrets: Public upstream source commit pin.
    commit: "914e7df21a07ef503a81201c76d2b11c789d3fca",
    releaseId: 303_326_868,
    assets: {
      "linux-x64": {
        assetId: 384_924_896,
        bytes: 2_353_908,
        updatedAt: "2026-03-30T17:49:19Z",
      },
      "darwin-arm64": {
        assetId: 384_924_893,
        bytes: 2_164_202,
        updatedAt: "2026-03-30T17:49:19Z",
      },
    },
  },
  shellcheck: {
    version: "0.11.0",
    license: "GPL-3.0-or-later",
    repository: "koalaman/shellcheck",
    tag: "v0.11.0",
    // biome-ignore lint/security/noSecrets: Public upstream source commit pin.
    commit: "aac0823e6b58f8a499e856e93738082691cbf212",
    releaseId: 237_202_770,
    assets: {
      "linux-x64": {
        assetId: 336_391_469,
        bytes: 3_773_312,
        updatedAt: "2026-01-05T03:12:27Z",
      },
      "darwin-arm64": {
        assetId: 336_391_359,
        bytes: 11_370_575,
        updatedAt: "2026-01-05T03:12:07Z",
      },
    },
  },
  gitleaks: {
    version: "8.30.1",
    license: "MIT",
    repository: "gitleaks/gitleaks",
    tag: "v8.30.1",
    // biome-ignore lint/security/noSecrets: Public upstream source commit pin.
    commit: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
    releaseId: 299_662_760,
    assets: {
      "linux-x64": {
        assetId: 378_332_058,
        bytes: 8_230_402,
        updatedAt: "2026-03-21T02:17:23Z",
      },
      "darwin-arm64": {
        assetId: 378_332_059,
        bytes: 7_897_593,
        updatedAt: "2026-03-21T02:16:56Z",
      },
    },
  },
};

export type { RequiredAssetFacts, RequiredToolFacts };
export { REQUIRED_TOOL_FACTS };
