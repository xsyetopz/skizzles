export interface ComposeModel {
  services?: Record<string, Record<string, unknown>>;
  volumes?: Record<string, Record<string, unknown> | null>;
  networks?: Record<string, Record<string, unknown> | null>;
  secrets?: Record<string, unknown>;
  configs?: Record<string, unknown>;
}
