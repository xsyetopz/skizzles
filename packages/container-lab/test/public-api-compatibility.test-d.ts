import type {} from "../src/compose/generation.ts";
import type {} from "../src/compose/inspection.ts";
import type {} from "../src/compose/model.ts";
import type {} from "../src/config.ts";

declare module "../src/compose/model.ts" {
  interface ComposeModel {
    readonly publicApiCompatibilityMarker?: never;
  }
}

declare module "../src/compose/generation.ts" {
  interface ComposeCommandOptions {
    readonly publicApiCompatibilityMarker?: never;
  }

  interface LabComposeContext {
    readonly publicApiCompatibilityMarker?: never;
  }
}

declare module "../src/compose/inspection.ts" {
  interface ComposeInspectionFinding {
    readonly publicApiCompatibilityMarker?: never;
  }
}

declare module "../src/config.ts" {
  interface RuntimeConfig {
    readonly publicApiCompatibilityMarker?: never;
  }
}
