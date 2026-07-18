import { describe, expect, test } from "bun:test";
import {
  inspectComposeModel,
  validateSecretEnvironmentModel,
} from "./compose-inspection.ts";
import type { ComposeModel } from "./compose-model.ts";

function composeVariable(expression: string): string {
  return `\${${expression}}`;
}

describe("inspectComposeModel", () => {
  test("reports notable privilege surfaces and redacts sensitive details", () => {
    const findings = inspectComposeModel({
      services: {
        api: {
          privileged: true,
          pid: "host",
          cap_add: ["SYS_ADMIN"],
          devices: ["/dev/kvm:/dev/kvm"],
          volumes: [
            { type: "bind", source: "/Users/example/private", target: "/src" },
            "/var/run/docker.sock:/var/run/docker.sock",
          ],
          ports: [
            { target: 3000, published: "3000", host_ip: "0.0.0.0" },
            { target: 4000, published: "0", host_ip: "127.0.0.1" },
          ],
          secrets: ["production-token"],
          configs: [{ source: "private-config" }],
        },
      },
      secrets: { "production-token": { file: "/private/token" } },
      configs: { "private-config": { file: "/private/config" } },
    });

    expect(findings.map((finding) => finding.surface)).toEqual([
      "privileged",
      "host-namespace",
      "capability",
      "device",
      "host-bind",
      "host-bind",
      "socket-bind",
      "fixed-port",
      "non-loopback-port",
      "secret",
      "config",
      "secret",
      "config",
    ]);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain("/Users/example/private");
    expect(serialized).not.toContain("docker.sock");
    expect(serialized).not.toContain("production-token");
    expect(serialized).not.toContain("private-config");
    expect(serialized).not.toContain("3000");
  });

  test("does not flag random loopback publication", () => {
    expect(
      inspectComposeModel({
        services: { api: { ports: ["127.0.0.1::8080"] } },
      }),
    ).toEqual([]);
  });

  test("reports engine API and build credential forwarding without exposing identities", () => {
    const findings = inspectComposeModel({
      services: {
        api: {
          use_api_socket: true,
          build: { ssh: ["default"], secrets: ["registry-token"] },
        },
      },
    });
    expect(findings.map((finding) => finding.surface)).toEqual([
      "socket-bind",
      "secret",
      "secret",
    ]);
    expect(JSON.stringify(findings)).not.toContain("registry-token");
    expect(JSON.stringify(findings)).not.toContain("default");
  });
});

describe("validateSecretEnvironmentModel", () => {
  test("accepts an allowlisted present top-level environment secret source", () => {
    expect(() =>
      validateSecretEnvironmentModel(
        {
          services: { api: {} },
          secrets: { token: { environment: "REGISTRY_TOKEN" } },
        },
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).not.toThrow();
  });

  test("rejects undeclared and unavailable environment secret sources using names only", () => {
    expect(() =>
      validateSecretEnvironmentModel(
        {
          secrets: { token: { environment: "UNDECLARED_TOKEN" } },
        },
        [],
        { UNDECLARED_TOKEN: "sentinel-value" },
      ),
    ).toThrow("not declared: UNDECLARED_TOKEN");
    expect(() =>
      validateSecretEnvironmentModel(
        {
          secrets: { token: { environment: "MISSING_TOKEN" } },
        },
        ["MISSING_TOKEN"],
        {},
      ),
    ).toThrow("unavailable: MISSING_TOKEN");
  });

  test("validates secret definitions before plaintext service references", () => {
    expect(() =>
      validateSecretEnvironmentModel(
        {
          services: { api: { environment: { REGISTRY_TOKEN: "value" } } },
          secrets: { token: { environment: "UNDECLARED_TOKEN" } },
        },
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).toThrow(
      "Compose secret environment source is not declared: UNDECLARED_TOKEN",
    );
  });

  test("rejects name references from plaintext service environment without value matching", () => {
    for (const environment of [
      { REGISTRY_TOKEN: "literal-does-not-matter" },
      { OTHER: composeVariable("REGISTRY_TOKEN") },
      ["OTHER=$REGISTRY_TOKEN"],
    ]) {
      expect(() =>
        validateSecretEnvironmentModel(
          { services: { api: { environment } } },
          ["REGISTRY_TOKEN"],
          { REGISTRY_TOKEN: "sentinel-value" },
        ),
      ).toThrow("api:REGISTRY_TOKEN");
    }
    expect(() =>
      validateSecretEnvironmentModel(
        {
          services: { api: { environment: { OTHER: "common-value" } } },
        },
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "common-value" },
      ),
    ).not.toThrow();
  });

  test("rejects declared secret references throughout the normalized model", () => {
    const models: ComposeModel[] = [
      {
        services: {
          api: { command: ["/bin/sh", "-lc", "echo $REGISTRY_TOKEN"] },
        },
      },
      {
        services: {
          api: {
            build: { args: { TOKEN: composeVariable("REGISTRY_TOKEN") } },
          },
        },
      },
      {
        services: {
          api: {
            labels: {
              "example.leak": `token=${composeVariable(
                "REGISTRY_TOKEN:-missing",
              )}`,
            },
          },
        },
      },
      {
        services: {
          api: {
            healthcheck: {
              test: ["CMD-SHELL", `test -n "\${REGISTRY_TOKEN/untrusted}"`],
            },
          },
        },
      },
    ];
    for (const model of models) {
      expect(() =>
        validateSecretEnvironmentModel(model, ["REGISTRY_TOKEN"], {
          REGISTRY_TOKEN: "sentinel-value",
        }),
      ).toThrow(
        "Compose model references declared secret environment source: REGISTRY_TOKEN",
      );
    }
  });

  test("accepts normal secret source declarations and service attachments", () => {
    expect(() =>
      validateSecretEnvironmentModel(
        {
          services: {
            api: {
              secrets: [
                "REGISTRY_TOKEN",
                {
                  source: "REGISTRY_TOKEN",
                  target: "registry-token",
                },
              ],
            },
          },
          secrets: { REGISTRY_TOKEN: { environment: "REGISTRY_TOKEN" } },
        },
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).not.toThrow();
  });
});
