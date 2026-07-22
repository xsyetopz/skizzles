// biome-ignore-all lint/security/noSecrets: Immutable public upstream commits and release digests are the contract.
import type { SecurityToolName, SecurityToolTarget } from "./contract.ts";

interface RequiredAssetFacts {
  url: string;
  sha256: string;
  executablePath: string;
  releaseApiUrl: string;
  releaseId: number;
  assetId: number;
  bytes: number;
  updatedAt: string;
  digest: string;
}

interface RequiredToolFacts {
  version: string;
  license: string;
  repository: string;
  tag: string;
  commit: string;
  versionCommand: readonly string[];
  versionOutputPattern: string;
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
    commit: "914e7df21a07ef503a81201c76d2b11c789d3fca",
    versionCommand: ["-version"],
    versionOutputPattern: "^1\\.7\\.12(?:\\r?\\n|$)",
    assets: {
      "linux-x64": {
        url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
        sha256:
          "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        executablePath: "actionlint",
        releaseApiUrl:
          "https://api.github.com/repos/rhysd/actionlint/releases/303326868",
        releaseId: 303_326_868,
        assetId: 384_924_896,
        bytes: 2_353_908,
        updatedAt: "2026-03-30T17:49:19Z",
        digest:
          "sha256:8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      },
      "darwin-arm64": {
        url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_arm64.tar.gz",
        sha256:
          "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
        executablePath: "actionlint",
        releaseApiUrl:
          "https://api.github.com/repos/rhysd/actionlint/releases/303326868",
        releaseId: 303_326_868,
        assetId: 384_924_893,
        bytes: 2_164_202,
        updatedAt: "2026-03-30T17:49:19Z",
        digest:
          "sha256:aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
      },
    },
  },
  shellcheck: {
    version: "0.11.0",
    license: "GPL-3.0-or-later",
    repository: "koalaman/shellcheck",
    tag: "v0.11.0",
    commit: "aac0823e6b58f8a499e856e93738082691cbf212",
    versionCommand: ["--version"],
    versionOutputPattern: "(?:^|\\n)version: 0\\.11\\.0(?:\\r?\\n|$)",
    assets: {
      "linux-x64": {
        url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz",
        sha256:
          "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
        executablePath: "shellcheck-v0.11.0/shellcheck",
        releaseApiUrl:
          "https://api.github.com/repos/koalaman/shellcheck/releases/237202770",
        releaseId: 237_202_770,
        assetId: 336_391_469,
        bytes: 3_773_312,
        updatedAt: "2026-01-05T03:12:27Z",
        digest:
          "sha256:b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
      },
      "darwin-arm64": {
        url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.darwin.aarch64.tar.gz",
        sha256:
          "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
        executablePath: "shellcheck-v0.11.0/shellcheck",
        releaseApiUrl:
          "https://api.github.com/repos/koalaman/shellcheck/releases/237202770",
        releaseId: 237_202_770,
        assetId: 336_391_359,
        bytes: 11_370_575,
        updatedAt: "2026-01-05T03:12:07Z",
        digest:
          "sha256:339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
      },
    },
  },
  gitleaks: {
    version: "8.30.1",
    license: "MIT",
    repository: "gitleaks/gitleaks",
    tag: "v8.30.1",
    commit: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
    versionCommand: ["version"],
    versionOutputPattern: "^8\\.30\\.1(?:\\r?\\n)?$",
    assets: {
      "linux-x64": {
        url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
        sha256:
          "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
        executablePath: "gitleaks",
        releaseApiUrl:
          "https://api.github.com/repos/gitleaks/gitleaks/releases/299662760",
        releaseId: 299_662_760,
        assetId: 378_332_058,
        bytes: 8_230_402,
        updatedAt: "2026-03-21T02:17:23Z",
        digest:
          "sha256:551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
      },
      "darwin-arm64": {
        url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz",
        sha256:
          "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
        executablePath: "gitleaks",
        releaseApiUrl:
          "https://api.github.com/repos/gitleaks/gitleaks/releases/299662760",
        releaseId: 299_662_760,
        assetId: 378_332_059,
        bytes: 7_897_593,
        updatedAt: "2026-03-21T02:16:56Z",
        digest:
          "sha256:b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
      },
    },
  },
};

export type { RequiredAssetFacts, RequiredToolFacts };
export { REQUIRED_TOOL_FACTS };
