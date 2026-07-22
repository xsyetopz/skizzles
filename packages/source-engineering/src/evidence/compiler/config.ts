import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { version as typeScriptVersion } from "typescript";
import { digestBytes } from "../../digest.ts";
import type { TrustedCompilerState } from "./authority-state.ts";
import type { CompilerSymbolAuthorityPort } from "./contract.ts";
import {
  exactRecord,
  inside,
  validDigest,
  validId,
} from "./input-validation.ts";

const maximumRepositoryIdentityLength = 256;
const maximumProfileIdentityLength = 128;

interface ParsedAuthorityConfig {
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: `sha256:${string}`;
  readonly configDigest: `sha256:${string}`;
  readonly rootPath: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly symbols: CompilerSymbolAuthorityPort | undefined;
}

export function parseAuthorityConfig(
  value: unknown,
): TrustedCompilerState | undefined {
  if (typeScriptVersion !== "7.0.2") {
    return;
  }
  const parsed = parseRegistration(value);
  if (parsed === undefined) {
    return;
  }
  try {
    return resolveTrustedState(parsed);
  } catch {
    return undefined;
  }
}

export function currentConfigMatches(state: TrustedCompilerState): boolean {
  try {
    return (
      digestBytes(readFileSync(state.configPath)) === state.configFileDigest
    );
  } catch {
    return false;
  }
}

function parseRegistration(value: unknown): ParsedAuthorityConfig | undefined {
  const record = exactRecord(value, ["repository", "profile"], ["symbols"]);
  const repository = exactRecord(record?.get("repository"), [
    "repositoryId",
    "rootIdentity",
    "treeDigest",
    "configDigest",
    "rootPath",
    "configPath",
  ]);
  const profile = exactRecord(record?.get("profile"), [
    "profileId",
    "toolId",
    "toolVersion",
  ]);
  const repositoryId = repository?.get("repositoryId");
  const rootIdentity = repository?.get("rootIdentity");
  const treeDigest = repository?.get("treeDigest");
  const configDigest = repository?.get("configDigest");
  const rootPath = repository?.get("rootPath");
  const configPath = repository?.get("configPath");
  const profileId = profile?.get("profileId");
  const symbols = record?.get("symbols");
  if (
    !(
      validId(repositoryId, maximumRepositoryIdentityLength) &&
      validId(rootIdentity, maximumRepositoryIdentityLength) &&
      validDigest(treeDigest) &&
      validDigest(configDigest) &&
      validId(profileId, maximumProfileIdentityLength)
    ) ||
    profile?.get("toolId") !== "typescript" ||
    profile.get("toolVersion") !== "7.0.2" ||
    typeof rootPath !== "string" ||
    typeof configPath !== "string" ||
    (symbols !== undefined && !validSymbolAuthority(symbols))
  ) {
    return;
  }
  return {
    repositoryId,
    rootIdentity,
    treeDigest,
    configDigest,
    rootPath,
    configPath,
    profileId,
    symbols,
  };
}

function resolveTrustedState(
  parsed: ParsedAuthorityConfig,
): TrustedCompilerState | undefined {
  const rootPath = realpathSync(parsed.rootPath);
  let requestedConfig = parsed.configPath;
  if (!isAbsolute(requestedConfig)) {
    requestedConfig = resolve(rootPath, requestedConfig);
  }
  const configPath = realpathSync(requestedConfig);
  if (
    !(
      inside(rootPath, configPath) &&
      statSync(rootPath).isDirectory() &&
      statSync(configPath).isFile()
    )
  ) {
    return;
  }
  return Object.freeze({
    bindings: Object.freeze({
      repositoryId: parsed.repositoryId,
      rootIdentity: parsed.rootIdentity,
      treeDigest: parsed.treeDigest,
      configDigest: parsed.configDigest,
      profileId: parsed.profileId,
      toolId: "typescript",
      toolVersion: "7.0.2",
    }),
    rootPath,
    configPath,
    configFileDigest: digestBytes(readFileSync(configPath)),
    symbols: parsed.symbols,
  });
}

function validSymbolAuthority(
  value: unknown,
): value is CompilerSymbolAuthorityPort {
  return typeof exactRecord(value, ["inspect"])?.get("inspect") === "function";
}
