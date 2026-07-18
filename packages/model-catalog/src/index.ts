#!/usr/bin/env bun
import process from "node:process";
import {
  type CatalogRefreshOptions as RefreshOptions,
  type CatalogRefreshResult as RefreshResult,
  refreshCatalog as refresh,
} from "./catalog/refresh.ts";
import { applyLunaV2Overlay as overlayLuna } from "./catalog/schema.ts";
import { runModelCatalogCli } from "./cli.ts";
import {
  type LaunchAgentValues as AgentValues,
  renderLaunchAgent as renderAgent,
} from "./launch-agent.ts";

function applyLunaV2Overlay(value: unknown): ReturnType<typeof overlayLuna> {
  return overlayLuna(value);
}

function refreshCatalog(
  options: CatalogRefreshOptions,
): Promise<CatalogRefreshResult> {
  return refresh(options);
}

function renderLaunchAgent(
  template: string,
  values: LaunchAgentValues,
): string {
  return renderAgent(template, values);
}

if (import.meta.main) {
  try {
    await runModelCatalogCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      const { message } = error;
      console.error(message);
    } else {
      console.error("model catalog operation failed");
    }
    process.exit(1);
  }
}

export type CatalogRefreshOptions = RefreshOptions;
export type CatalogRefreshResult = RefreshResult;
export type LaunchAgentValues = AgentValues;
export { applyLunaV2Overlay, refreshCatalog, renderLaunchAgent };
