import type {} from "./compose.ts";
import type {} from "./config.ts";

declare module "./compose.ts" {
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

declare module "./config.ts" {
  interface RuntimeConfig {
    readonly publicApiCompatibilityMarker?: never;
  }
}
