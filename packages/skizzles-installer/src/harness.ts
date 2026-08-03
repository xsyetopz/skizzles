import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  copyDirectoryExclusive,
  pathEntryExists,
  removeOwnedPathsTransactionally,
  sameTree,
  type MovePath,
  type Transfer,
} from "./managed-filesystem";

interface Marketplace {
  name: string;
  interface?: { displayName?: string };
  plugins: Array<Record<string, unknown>>;
}

export interface HarnessReceipt {
  version: 1;
  sourceRoot: string;
  transfer: Transfer;
  pluginTarget: string;
  marketplacePath: string;
  marketplaceAfter: string;
}

export interface HarnessOptions {
  home: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

export type HarnessApplyStatus = "install" | "noop";
export type HarnessConflictStatus = "foreign-conflict" | "drift-conflict";

export interface HarnessInspection {
  status: "install" | "noop" | HarnessConflictStatus;
  pluginTarget: string;
  marketplacePath: string;
  receiptPath: string;
  receipt?: HarnessReceipt;
  reason?: string;
}

export interface EnsureHarnessResult {
  receipt: HarnessReceipt;
  status: HarnessApplyStatus;
  inspection: HarnessInspection;
}

export function harnessReceiptPath(home: string): string {
  return join(resolve(home), ".skizzles", "harness-receipt.json");
}

function pluginEntry(): Record<string, unknown> {
  return {
    name: "skizzles",
    source: { source: "local", path: "./plugins/skizzles" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
}

function marketplaceWithSkizzles(): string {
  const marketplace: Marketplace = { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
  marketplace.plugins.push(pluginEntry());
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

function readReceipt(home: string): HarnessReceipt {
  const path = harnessReceiptPath(home);
  if (!existsSync(path)) throw new Error(`Skizzles harness receipt is missing: ${path}`);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Partial<HarnessReceipt>;
  if (receipt.version !== 1 || (receipt.transfer !== "link" && receipt.transfer !== "copy")) {
    throw new Error(`invalid Skizzles harness receipt: ${path}`);
  }
  return receipt as HarnessReceipt;
}

/** Inspect checkout-harness ownership without changing any target. */
export function inspectHarness(options: HarnessOptions): HarnessInspection {
  const home = resolve(options.home);
  const sourceRoot = resolve(options.sourceRoot);
  const pluginSource = join(sourceRoot, "plugins", "skizzles");
  const pluginTarget = join(home, "plugins", "skizzles");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const receiptPath = harnessReceiptPath(home);
  assertManagedParentsAreReal(home, ["plugins", ".agents", ".agents/plugins", ".skizzles"]);
  if (!existsSync(join(pluginSource, ".codex-plugin", "plugin.json"))) {
    throw new Error(`generated plugin is missing: ${pluginSource}`);
  }
  if (!pathEntryExists(receiptPath)) {
    if (pathEntryExists(pluginTarget)) {
      return { status: "foreign-conflict", pluginTarget, marketplacePath, receiptPath, reason: "plugin target exists without a Skizzles receipt" };
    }
    if (pathEntryExists(marketplacePath)) {
      return { status: "foreign-conflict", pluginTarget, marketplacePath, receiptPath, reason: "marketplace exists without a Skizzles receipt" };
    }
    return { status: "install", pluginTarget, marketplacePath, receiptPath };
  }

  let receipt: HarnessReceipt;
  try {
    receipt = readReceipt(home);
  } catch (error) {
    return {
      status: "drift-conflict",
      pluginTarget,
      marketplacePath,
      receiptPath,
      reason: error instanceof Error ? error.message : "invalid Skizzles harness receipt",
    };
  }
  if (
    resolve(receipt.pluginTarget) !== pluginTarget ||
    resolve(receipt.marketplacePath) !== marketplacePath ||
    resolve(receipt.sourceRoot) !== sourceRoot ||
    receipt.transfer !== options.transfer
  ) {
    return { status: "drift-conflict", pluginTarget, marketplacePath, receiptPath, receipt, reason: "receipt targets or transfer differ" };
  }
  if (!pathEntryExists(pluginTarget) || !pathEntryExists(marketplacePath)) {
    return { status: "drift-conflict", pluginTarget, marketplacePath, receiptPath, receipt, reason: "receipt-owned target is missing" };
  }
  const pluginHealthy = receipt.transfer === "link"
    ? lstatSync(pluginTarget).isSymbolicLink() && resolve(dirname(pluginTarget), readlinkSync(pluginTarget)) === resolve(pluginSource)
    : sameTree(pluginSource, pluginTarget);
  if (!pluginHealthy) {
    return { status: "drift-conflict", pluginTarget, marketplacePath, receiptPath, receipt, reason: "receipt-owned plugin drifted" };
  }
  if (readFileSync(marketplacePath, "utf8") !== receipt.marketplaceAfter) {
    return { status: "drift-conflict", pluginTarget, marketplacePath, receiptPath, receipt, reason: "receipt-owned marketplace drifted" };
  }
  return { status: "noop", pluginTarget, marketplacePath, receiptPath, receipt };
}

export function ensureHarness(options: HarnessOptions): EnsureHarnessResult {
  const inspection = inspectHarness(options);
  if (inspection.status === "foreign-conflict" || inspection.status === "drift-conflict") {
    throw new Error(`harness ${inspection.status}: ${inspection.reason ?? "target is not receipt-owned"}`);
  }
  if (inspection.status === "noop") {
    return { receipt: inspection.receipt!, status: "noop", inspection };
  }
  const receipt = installHarness(options);
  return { receipt, status: "install", inspection };
}

export function installHarness(options: HarnessOptions): HarnessReceipt {
  const home = resolve(options.home);
  const sourceRoot = resolve(options.sourceRoot);
  const pluginSource = join(sourceRoot, "plugins", "skizzles");
  const pluginTarget = join(home, "plugins", "skizzles");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const receiptPath = harnessReceiptPath(home);
  assertManagedParentsAreReal(home, ["plugins", ".agents", ".agents/plugins", ".skizzles"]);
  if (!existsSync(join(pluginSource, ".codex-plugin", "plugin.json"))) {
    throw new Error(`generated plugin is missing: ${pluginSource}`);
  }
  if (pathEntryExists(pluginTarget)) throw new Error(`refusing to replace existing plugin: ${pluginTarget}`);
  if (pathEntryExists(receiptPath)) throw new Error(`Skizzles harness receipt already exists: ${receiptPath}`);
  if (pathEntryExists(marketplacePath)) throw new Error(`isolated harness requires an absent marketplace: ${marketplacePath}`);
  const marketplaceAfter = marketplaceWithSkizzles();
  const receipt: HarnessReceipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    pluginTarget,
    marketplacePath,
    marketplaceAfter,
  };
  if (options.dryRun) return receipt;

  let pluginCreated = false;
  let marketplaceCreated = false;
  let receiptCreated = false;
  try {
    mkdirSync(dirname(pluginTarget), { recursive: true });
    if (options.transfer === "link") symlinkSync(pluginSource, pluginTarget, "dir");
    else copyDirectoryExclusive(pluginSource, pluginTarget);
    pluginCreated = true;
    mkdirSync(dirname(marketplacePath), { recursive: true });
    writeFileSync(marketplacePath, marketplaceAfter, { flag: "wx" });
    marketplaceCreated = true;
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    receiptCreated = true;
  } catch (error) {
    if (receiptCreated) rmSync(receiptPath, { force: true });
    if (marketplaceCreated) rmSync(marketplacePath, { force: true });
    if (pluginCreated) {
      try {
        const ownedPlugin = options.transfer === "link"
          ? lstatSync(pluginTarget).isSymbolicLink() && resolve(dirname(pluginTarget), readlinkSync(pluginTarget)) === resolve(pluginSource)
          : sameTree(pluginSource, pluginTarget);
        if (ownedPlugin) rmSync(pluginTarget, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
  return receipt;
}

export function uninstallHarness(
  homeInput: string,
  dryRun = false,
  move?: MovePath,
): HarnessReceipt {
  const home = resolve(homeInput);
  assertManagedParentsAreReal(home, ["plugins", ".agents", ".agents/plugins", ".skizzles"]);
  const receipt = readReceipt(home);
  const expectedTarget = join(home, "plugins", "skizzles");
  const expectedMarketplace = join(home, ".agents", "plugins", "marketplace.json");
  if (resolve(receipt.pluginTarget) !== expectedTarget || resolve(receipt.marketplacePath) !== expectedMarketplace) {
    throw new Error("harness receipt targets are outside the selected HOME");
  }
  if (!pathEntryExists(receipt.pluginTarget)) throw new Error("owned plugin target is missing");
  const pluginSource = join(receipt.sourceRoot, "plugins", "skizzles");
  if (receipt.transfer === "link") {
    if (!lstatSync(receipt.pluginTarget).isSymbolicLink()) throw new Error("owned plugin link changed type");
    const actual = resolve(dirname(receipt.pluginTarget), readlinkSync(receipt.pluginTarget));
    if (actual !== resolve(pluginSource)) throw new Error("owned plugin link target drifted");
  } else if (!sameTree(pluginSource, receipt.pluginTarget)) {
    throw new Error("owned copied plugin drifted");
  }
  if (!existsSync(receipt.marketplacePath) || readFileSync(receipt.marketplacePath, "utf8") !== receipt.marketplaceAfter) {
    throw new Error("marketplace changed after Skizzles installation");
  }
  if (dryRun) return receipt;
  removeOwnedPathsTransactionally(
    join(home, ".skizzles"),
    "harness-uninstall",
    [
      { source: receipt.marketplacePath, name: "marketplace.json" },
      { source: receipt.pluginTarget, name: "plugin" },
      { source: harnessReceiptPath(home), name: "receipt.json" },
    ],
    move,
  );
  return receipt;
}
