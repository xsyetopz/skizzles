import { describe, expect, it } from "bun:test";
import {
  createConfigurationRegistry,
  createSecretScanner,
  isSecretScanner,
  scanCandidateSecrets,
} from "../src/index.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("candidate secret gate", () => {
  it("rejects env/config paths and credential-shaped bytes", () => {
    const alphabet =
      Array.from({ length: 26 }, (_, index) =>
        String.fromCharCode(65 + index),
      ).join("") +
      Array.from({ length: 26 }, (_, index) =>
        String.fromCharCode(97 + index),
      ).join("") +
      Array.from({ length: 10 }, (_, index) =>
        String.fromCharCode(48 + index),
      ).join("") +
      "+/=";
    const highEntropy = Array.from(
      { length: 48 },
      (_, index) => alphabet[(index * 29) % alphabet.length],
    ).join("");
    const result = scanCandidateSecrets({
      candidates: [
        { path: ".env", bytes: bytes(["TOKEN", "placeholder"].join("=")) },
        { path: "config/production.json", bytes: bytes('{"mode":"prod"}\n') },
        {
          path: "src/settings.ts",
          bytes: bytes(`const token = '${highEntropy}';\n`),
        },
      ],
      configurationPaths: ["config/production.json"],
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "FORBIDDEN_ENV_PATH",
        "FORBIDDEN_CONFIG_PATH",
        "CREDENTIAL_STRUCTURE",
        "HIGH_ENTROPY_SECRET",
      ]),
    );
    expect(JSON.stringify(result.receipt)).not.toContain(highEntropy);
  });

  it("accepts exact structured configuration receipts and rejects forged inputs", () => {
    const registry = createConfigurationRegistry({
      definitions: [{ key: "endpoint", path: ".env", kind: "string" }],
    });
    expect(
      registry.register({ key: "endpoint", value: "https://service.invalid" })
        .ok,
    ).toBe(true);
    const materialized = registry.materialize({ key: "endpoint" });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) {
      return;
    }
    const scanner = createSecretScanner();
    expect(isSecretScanner(scanner)).toBe(true);
    expect(
      scanner.scan({
        candidates: [{ path: ".env", bytes: materialized.bytes }],
        authorizedConfigurationWrites: [materialized.receipt],
      }).ok,
    ).toBe(true);
    const proxy = new Proxy(
      { candidates: [{ path: "src/value.ts", bytes: bytes("ok") }] },
      {
        get: () => {
          throw new Error("accessor executed");
        },
      },
    );
    expect(scanner.scan(proxy).ok).toBe(false);
  });

  it("scans non-UTF8 candidate bytes instead of skipping them", () => {
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    const result = createSecretScanner().scan({
      candidates: [{ path: "src/blob.bin", bytes: binary }],
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.findings.map((finding) => finding.code)).toContain(
      "HIGH_ENTROPY_SECRET",
    );
  });
});
