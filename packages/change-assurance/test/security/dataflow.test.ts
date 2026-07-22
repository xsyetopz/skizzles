// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";
import {
  createSecurityPolicyLinter,
  type SecurityPolicyLintReceipt,
} from "../../src/index.ts";
import { acceptedSource, gateFixture, policy } from "./fixture.ts";

describe("security policy semantic dataflow", () => {
  it("accepts only the trusted, dominating middleware path", async () => {
    const receipt = await lint({ "src/entry.ts": acceptedSource });
    expect(receipt.status).toBe("clear");
    expect(receipt.findings).toEqual([]);
  });

  it("tracks variables and wrapper calls across namespace and re-export boundaries", async () => {
    const receipt = await lint({
      "src/data.ts": `
import { query } from "pg";
export function run(value: string) {
  query(value);
}
`,
      "src/barrel.ts": `export { run as executeQuery } from "./data.ts";`,
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
import * as database from "./barrel.ts";
export function handle(request: { query: { id: string } }) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  const id = request.query.id;
  const statement = "select * from users where id = " + id;
  database.executeQuery(statement);
  return request;
}
`,
    });
    expect(receipt.status).toBe("findings");
    expect(receipt.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "TAINTED_DATABASE_FLOW",
        "RAW_DATABASE_PRIMITIVE",
      ]),
    );
    expect(
      receipt.findings.every(({ traceDigest }) =>
        traceDigest.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("select * from users");
  });

  it("does not trust a sanitizer-shaped local function", async () => {
    const receipt = await lint({
      "src/entry.ts": `
import { rateLimit, auditLog } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
function sanitizeInput(value: unknown) { return value; }
export function handle(request: unknown) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  return request;
}
`,
    });
    expect(receipt.findings.map(({ code }) => code)).toContain(
      "MIDDLEWARE_NOT_DOMINANT",
    );
  });

  it("rejects middleware that executes on only one control-flow branch", async () => {
    const receipt = await lint({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: unknown) {
  if (request) {
    rateLimit(10, 60000);
    auditLog({ requestId: request });
    sanitizeInput(request);
  }
  sessionBoundary(request);
  return request;
}
`,
    });
    expect(
      receipt.findings.filter(({ code }) => code === "MIDDLEWARE_NOT_DOMINANT")
        .length,
    ).toBeGreaterThan(0);
  });

  it("fails closed on computed module and call resolution", async () => {
    const receipt = await lint({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: unknown, moduleName: string, method: string) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  const loaded = require(moduleName);
  loaded[method](request);
  return request;
}
`,
    });
    const dynamic = receipt.findings.filter(
      ({ code }) => code === "DYNAMIC_SECURITY_DISPATCH",
    );
    expect(dynamic.length).toBeGreaterThanOrEqual(2);
    expect(dynamic.every(({ severity }) => severity === "critical")).toBe(true);
  });

  it("taints binding patterns and resolves global execution element access", async () => {
    const variants = [
      `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
const exec = (value: string) => Bun["spawn"]([value]);
export function handle({ cmd }: { cmd: string }) {
  rateLimit(10, 60000);
  auditLog({ requestId: cmd });
  sanitizeInput(cmd);
  exec(cmd);
  return cmd;
}
`,
      `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
const exec = (value: string) => Bun.spawn([value]);
export function handle([cmd]: [string]) {
  rateLimit(10, 60000);
  auditLog({ requestId: cmd });
  sanitizeInput(cmd);
  exec(cmd);
  return cmd;
}
`,
      `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
const exec = ({ cmd }: { cmd: string }) => globalThis["spawn"]([cmd]);
export function handle(request: { job: { cmd: string } }) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  const { job: { cmd } } = request;
  exec({ cmd });
  return cmd;
}
`,
    ];
    for (const source of variants) {
      const receipt = await lint({ "src/entry.ts": source });
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "TAINTED_EXECUTION_FLOW",
      );
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "MISSING_SECURE_INTERFACE",
      );
    }
  });

  it("tracks a destructuring wrapper across changed files", async () => {
    const receipt = await lint({
      "src/runner.ts": `
export function exec({ cmd }: { cmd: string }) {
  return Bun["spawn"]([cmd]);
}
`,
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
import { exec } from "./runner.ts";
export function handle({ cmd }: { cmd: string }) {
  rateLimit(10, 60000);
  auditLog({ requestId: cmd });
  sanitizeInput(cmd);
  sessionBoundary(cmd);
  exec({ cmd });
  return cmd;
}
`,
    });
    const runnerFindings = receipt.findings.filter(
      ({ path }) => path === "src/runner.ts",
    );
    expect(runnerFindings.map(({ code }) => code)).toContain(
      "TAINTED_EXECUTION_FLOW",
    );
    expect(runnerFindings.map(({ code }) => code)).toContain(
      "DYNAMIC_SECURITY_DISPATCH",
    );
  });

  it("requires secure-interface use to dominate each sink", async () => {
    const receipt = await lint({
      "src/entry.ts": `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
function query(value: string) { return value; }
export function handle({ cmd, trusted }: { cmd: string; trusted: boolean }) {
  rateLimit(10, 60000);
  auditLog({ requestId: cmd });
  sanitizeInput(cmd);
  if (trusted) sessionBoundary(cmd);
  query(cmd);
  return cmd;
}
`,
    });
    expect(receipt.findings.map(({ code }) => code)).toContain(
      "MISSING_SECURE_INTERFACE",
    );
  });

  it("tracks member writes into reflective execution sinks", async () => {
    const variants = [
      `
const channel: { value?: string } = {};
channel.value = request.cmd;
Reflect.apply(Bun.spawn, Bun, [[channel.value ?? ""]]);
`,
      `
const channel: Record<string, string> = {};
channel["value"] = request.cmd;
Bun.spawn.call(Bun, [channel["value"]]);
`,
      `
const channel: Record<string, string> = {};
const key: string = "value";
channel[key] = request.cmd;
Reflect.apply(Bun["spawn"], Bun, [[channel[key] ?? ""]]);
`,
      `
const channel: { value?: string } = {};
const alias = channel;
alias.value = request.cmd;
const launch = Bun.spawn;
Reflect.apply(launch, Bun, [[channel.value ?? ""]]);
`,
      `
const launch = Bun.spawn.bind(Bun);
launch([request.cmd]);
`,
    ];
    for (const body of variants) {
      const receipt = await lint({
        "src/entry.ts": securedEntrypoint(body),
      });
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "TAINTED_EXECUTION_FLOW",
      );
    }
  });

  it("fails closed on unresolved reflective dispatch", async () => {
    const variants = [
      "Reflect.apply(request.target, null, [[request.cmd]]);",
      "request.target.apply(null, [[request.cmd]]);",
      "Reflect[request.method](request.target, null, [[request.cmd]]);",
    ];
    for (const body of variants) {
      const receipt = await lint({
        "src/entry.ts": securedEntrypoint(body),
      });
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "DYNAMIC_SECURITY_DISPATCH",
      );
    }
  });

  it("propagates heap taint conservatively through control flow", async () => {
    const variants = [
      "for (const value of [request.cmd]) { channel.value = value; }",
      "while (request.cmd) { channel.value = request.cmd; break; }",
      "do { channel.value = request.cmd; } while (false);",
      "for (let index = 0; index < 1; index += 1) { channel.value = request.cmd; }",
      `switch (request.cmd) { case "run": channel.value = request.cmd; break; default: break; }`,
      `try { channel.value = request.cmd; } catch { channel.value = "safe"; } finally { channel.value = channel.value; }`,
    ];
    for (const controlFlow of variants) {
      const receipt = await lint({
        "src/entry.ts": securedEntrypoint(`
const channel: { value?: string } = {};
${controlFlow}
Reflect.apply(Bun.spawn, Bun, [[channel.value ?? ""]]);
`),
      });
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "TAINTED_EXECUTION_FLOW",
      );
    }
  });

  it("forbids raw global sink provenance regardless of call shape", async () => {
    const variants = [
      `Bun.spawn(["ls"]);`,
      `(0, Bun.spawn)(["ls"]);`,
      `(void 0, Bun.spawn)(["ls"]);`,
      `(request.cmd ? Bun.spawn : Bun.spawn)(["ls"]);`,
      `const runtime = Bun; runtime.spawn(["ls"]);`,
      `const { spawn } = Bun; spawn(["ls"]);`,
      `const { spawn: run } = Bun; run(["ls"]);`,
      `const { Bun: { spawn: run } } = globalThis; run(["ls"]);`,
    ];
    for (const body of variants) {
      const receipt = await lint({
        "src/entry.ts": securedEntrypoint(body),
      });
      expect(receipt.findings.map(({ code }) => code)).toContain(
        "RAW_EXECUTION_PRIMITIVE",
      );
    }
    const direct = await lint({
      "src/entry.ts": securedEntrypoint(`Bun.spawn(["ls"]);`),
    });
    expect(direct.findings.map(({ code }) => code)).toContain(
      "MISSING_SECURE_INTERFACE",
    );
    const computed = await lint({
      "src/entry.ts": securedEntrypoint(
        `const methodName = "spawn"; const method = Bun[methodName]; method(["ls"]);`,
      ),
    });
    expect(computed.findings.map(({ code }) => code)).toContain(
      "DYNAMIC_SECURITY_DISPATCH",
    );
  });

  it("rejects sink interfaces whose declared capability does not match", async () => {
    const mismatched = Object.freeze({
      ...policy,
      sinks: Object.freeze([
        Object.freeze({
          capability: "execution" as const,
          names: Object.freeze(["spawn"]),
          secureInterfaceIds: Object.freeze(["session-interface"]),
        }),
      ]),
    });
    const fixture = await gateFixture({ "src/entry.ts": acceptedSource });
    const result = createSecurityPolicyLinter(
      Object.freeze({
        authorityId: "host/mismatched-security-policy",
        assurance: fixture.assurance,
        policy: mismatched,
      }),
    );
    expect(result).toEqual({
      status: "rejected",
      code: "INVALID_LINTER_CONFIG",
    });
  });
});

function securedEntrypoint(body: string): string {
  return `
import { rateLimit, auditLog, sanitizeInput } from "@app/security-middleware";
import { sessionBoundary } from "@app/session";
export function handle(request: { cmd: string; method: string; target: Function }) {
  rateLimit(10, 60000);
  auditLog({ requestId: request });
  sanitizeInput(request);
  sessionBoundary(request);
  ${body}
  return request;
}
`;
}

async function lint(
  sources: Readonly<Record<string, string>>,
): Promise<SecurityPolicyLintReceipt> {
  const fixture = await gateFixture(sources, policy);
  const result = await fixture.linter.lint(
    Object.freeze({
      assessment: fixture.assessment,
      assuranceReceipt: fixture.assuranceReceipt,
    }),
  );
  if (result.status !== "completed") throw new Error(result.code);
  return result.receipt;
}
