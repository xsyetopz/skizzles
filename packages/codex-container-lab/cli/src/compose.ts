import {
  generateBaseCompose as buildBaseCompose,
  composeCommandArgs as buildComposeCommandArgs,
  internalImageTag as buildInternalImageTag,
  generateOverrideCompose as buildOverrideCompose,
  type ComposeCommandOptions as GenerationCommandOptions,
  type LabComposeContext as GenerationComposeContext,
} from "./compose-generation.ts";
import {
  type ComposeInspectionFinding as InspectionFinding,
  type PrivilegeSurface as InspectionPrivilegeSurface,
  inspectComposeModel as inspectNormalizedComposeModel,
  validateSecretEnvironmentModel as validateNormalizedSecretEnvironment,
} from "./compose-inspection.ts";
import type { ComposeModel as NormalizedComposeModel } from "./compose-model.ts";
import type { LabConfig } from "./config.ts";

export interface ComposeModel extends NormalizedComposeModel {}
export interface ComposeCommandOptions extends GenerationCommandOptions {}
export interface LabComposeContext extends GenerationComposeContext {}
export interface ComposeInspectionFinding extends InspectionFinding {}
export type PrivilegeSurface = InspectionPrivilegeSurface;

export function composeCommandArgs(
  config: LabConfig,
  options: ComposeCommandOptions,
): string[] {
  return buildComposeCommandArgs(config, options);
}

export function generateBaseCompose(config: LabConfig): string | undefined {
  return buildBaseCompose(config);
}

export function generateOverrideCompose(
  config: LabConfig,
  model: ComposeModel,
  context: LabComposeContext,
): string {
  return buildOverrideCompose(config, model, context);
}

export function internalImageTag(ownerKey: string, labId: string): string {
  return buildInternalImageTag(ownerKey, labId);
}

export function inspectComposeModel(
  model: ComposeModel,
): ComposeInspectionFinding[] {
  return inspectNormalizedComposeModel(model);
}

export function validateSecretEnvironmentModel(
  model: ComposeModel,
  declaredNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  validateNormalizedSecretEnvironment(model, declaredNames, environment);
}
