import type {} from "../src/compose.ts";
import type {} from "../src/config.ts";

declare module "../src/compose.ts" {
  interface ComposeModel {
    readonly publicApiCompatibilityMarker?: never;
  }

  interface ComposeCommandOptions {
    readonly publicApiCompatibilityMarker?: never;
  }

  interface LabComposeContext {
    readonly publicApiCompatibilityMarker?: never;
  }

  interface ComposeInspectionFinding {
    readonly publicApiCompatibilityMarker?: never;
  }
}

declare module "../src/config.ts" {
  interface RuntimeConfig {
    readonly publicApiCompatibilityMarker?: never;
  }
}
