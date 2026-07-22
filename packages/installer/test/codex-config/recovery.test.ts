import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ConfigRpcError } from "../../src/codex-config.ts";
import {
  configReceiptPath,
  configureCodex,
  unconfigureCodex,
} from "../../src/config.ts";
import { factory, fixture } from "./support.ts";

describe("Codex configuration recovery", () => {
  test("removes a pending receipt when Codex rejects a concurrent edit", async () => {
    const f = fixture({});
    f.rpc.mutateBeforeWrite = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("Codex config version conflict");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("discards exact-before pending evidence after a pre-write rejection", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(f.rpc.writes).toBe(0);
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "pending", orchestration: "passive" });

    f.rpc.writeError = undefined;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("retries an exact-before pending configure with its recorded edits", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");

    f.rpc.writeError = undefined;
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.state).toBe("active");
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    expect(f.rpc.writes).toBe(1);
  });

  test("retains pending recovery evidence across a retry conflict", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    f.rpc.writeError = undefined;
    f.rpc.mutateBeforeWrite = true;

    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("Codex config version conflict");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "pending", orchestration: "passive" });
  });

  test("pending recovery requires its recorded orchestration mode", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    f.rpc.writeError = undefined;

    await expect(
      configureCodex({
        ...f,
        orchestration: "aggressive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("recorded mode");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
  });

  test("retains orchestration receipt when transport fails after commit", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.commitThenThrow = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    f.rpc.commitThenThrow = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("activates exact-after pending evidence without writing again", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.commitThenThrow = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(f.rpc.writes).toBe(1);

    f.rpc.commitThenThrow = false;
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.state).toBe("active");
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    expect(f.rpc.writes).toBe(1);
  });

  test("finishes exact-before restoring evidence after an ambiguous restore", async () => {
    const f = fixture({ features: { hooks: false } });
    await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    f.rpc.commitThenThrow = true;
    await expect(
      unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "restoring" });
    expect(f.rpc.writes).toBe(2);

    f.rpc.commitThenThrow = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.writes).toBe(2);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });
});
