#!/usr/bin/env bun
import {
  type CatalogRefreshOptions as RefreshOptions,
  type CatalogRefreshResult as RefreshResult,
  refreshCatalog as refresh,
} from "./model-catalog/catalog-refresh.ts";
import { applyLunaV2Overlay as overlayLuna } from "./model-catalog/catalog-schema.ts";
import { runModelCatalogCli } from "./model-catalog/cli.ts";
import {
  type LaunchAgentValues as AgentValues,
  renderLaunchAgent as renderAgent,
} from "./model-catalog/launch-agent.ts";

export interface CatalogRefreshOptions extends RefreshOptions {}
export interface CatalogRefreshResult extends RefreshResult {}
export interface LaunchAgentValues extends AgentValues {}

export function applyLunaV2Overlay(
  value: unknown,
): ReturnType<typeof overlayLuna> {
  return overlayLuna(value);
}

export function refreshCatalog(
  options: CatalogRefreshOptions,
): Promise<CatalogRefreshResult> {
  return refresh(options);
}

export function renderLaunchAgent(
  template: string,
  values: LaunchAgentValues,
): string {
  return renderAgent(template, values);
}

if (import.meta.main) {
  try {
    await runModelCatalogCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "model catalog operation failed",
    );
    process.exit(1);
  }
}
