import { describe, expect, it } from "bun:test";
import {
  inspectComposeModel,
  validateComposeEnvironmentModel,
} from "../../src/compose/inspection.ts";

function composeVariable(expression: string): string {
  return `\${${expression}}`;
}

describe("inspectComposeModel", () => {
  it("reports notable privilege surfaces and redacts sensitive details", () => {
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

  it("does not flag random loopback publication", () => {
    expect(
      inspectComposeModel({
        services: { api: { ports: ["127.0.0.1::8080"] } },
      }),
    ).toEqual([]);
  });

  it("reports engine API and build credential forwarding without exposing identities", () => {
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

describe("validateComposeEnvironmentModel", () => {
  it("accepts an allowlisted present top-level environment secret source", () => {
    expect(() =>
      validateComposeEnvironmentModel(
        {
          services: { api: {} },
          secrets: { token: { environment: "REGISTRY_TOKEN" } },
        },
        [],
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).not.toThrow();
  });

  it("rejects undeclared and unavailable environment secret sources using names only", () => {
    expect(() =>
      validateComposeEnvironmentModel(
        {
          secrets: { token: { environment: "UNDECLARED_TOKEN" } },
        },
        [],
        [],
        { UNDECLARED_TOKEN: "sentinel-value" },
      ),
    ).toThrow("not declared: UNDECLARED_TOKEN");
    expect(() =>
      validateComposeEnvironmentModel(
        {
          secrets: { token: { environment: "MISSING_TOKEN" } },
        },
        [],
        ["MISSING_TOKEN"],
        {},
      ),
    ).toThrow("unavailable: MISSING_TOKEN");
  });

  it("rejects unused secret capabilities and plaintext secret variable names", () => {
    expect(() =>
      validateComposeEnvironmentModel(
        { services: { api: {} } },
        [],
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).toThrow("not used by a top-level secret: REGISTRY_TOKEN");

    expect(() =>
      validateComposeEnvironmentModel(
        {
          services: { api: { environment: { REGISTRY_TOKEN: "value" } } },
          secrets: { token: { environment: "REGISTRY_TOKEN" } },
        },
        [],
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel-value" },
      ),
    ).toThrow("api:REGISTRY_TOKEN");
  });

  it("recognizes braced, unbraced, nested, default, and escaped interpolation", () => {
    const model = {
      services: {
        api: {
          command: [
            "$DIRECT",
            composeVariable("OUTER:-${INNER:?required}"),
            "$$LITERAL",
            "$$$$ALSO_LITERAL",
          ],
        },
      },
    };
    expect(() =>
      validateComposeEnvironmentModel(
        model,
        ["DIRECT", "OUTER", "INNER"],
        [],
        {},
      ),
    ).not.toThrow();
    expect(() =>
      validateComposeEnvironmentModel(model, ["DIRECT", "OUTER"], [], {}),
    ).toThrow("interpolation reads undeclared environment: INNER");
    expect(() =>
      validateComposeEnvironmentModel(
        { services: { api: { command: composeVariable("HOME") } } },
        [],
        [],
        { HOME: "/ambient/client-home" },
      ),
    ).toThrow("interpolation reads undeclared environment: HOME");
    expect(() =>
      validateComposeEnvironmentModel(
        { services: { api: { labels: { $LITERAL_KEY: "value" } } } },
        [],
        [],
        {},
      ),
    ).not.toThrow();
  });

  it("requires source authorization for null service environment and build arguments", () => {
    const model = {
      services: {
        api: {
          environment: { SERVICE_VALUE: null },
          build: { args: { BUILD_VALUE: null } },
        },
      },
    };
    expect(() =>
      validateComposeEnvironmentModel(
        model,
        ["SERVICE_VALUE", "BUILD_VALUE"],
        [],
        {},
      ),
    ).not.toThrow();
    expect(() => validateComposeEnvironmentModel(model, [], [], {})).toThrow(
      /reads undeclared environment/u,
    );
  });

  it("rejects environment-backed configs", () => {
    expect(() =>
      validateComposeEnvironmentModel(
        { configs: { source: { environment: "CONFIG_VALUE" } } },
        [],
        [],
        { CONFIG_VALUE: "value" },
      ),
    ).toThrow("configs.environment is not supported");
  });

  it("rejects unresolved service environment files", () => {
    expect(() =>
      validateComposeEnvironmentModel(
        {
          services: {
            dev: {
              env_file: [{ path: "/trusted/project/values.env" }],
            },
          },
        },
        [],
        ["REGISTRY_TOKEN"],
        { REGISTRY_TOKEN: "sentinel" },
      ),
    ).toThrow("Compose service env_file is not supported");
  });
});
