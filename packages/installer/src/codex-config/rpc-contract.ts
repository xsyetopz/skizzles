export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConfigEdit {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace";
}

export interface ConfigLayer {
  name: { type: string; file?: string; profile?: string | null };
  version: string;
  config: JsonValue;
}

export interface ConfigReadResponse {
  config?: JsonValue;
  layers: ConfigLayer[] | null;
}

export interface ConfigWriteResponse {
  status: string;
  version: string;
  filePath: string;
}

export interface ConfigRpc {
  read(): Promise<ConfigReadResponse>;
  batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse>;
  close(): Promise<void>;
}

export interface ConfigRpcSession {
  rpc: ConfigRpc;
  configPath: string;
  cleanup(): void;
}

export interface OwnedConfigValue {
  keyPath: string;
  beforePresent: boolean;
  before: JsonValue;
  after: JsonValue;
}
