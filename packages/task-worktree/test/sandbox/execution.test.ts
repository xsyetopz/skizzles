// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";
import {
  createPortableSandboxBroker,
  createSandboxCapabilityAuthority,
  type SandboxAuthorityExecutionRequest,
} from "../../src/sandbox/capabilities.ts";
import { broker, defaultLimits, fullAttestation } from "./support.ts";

describe("portable OS sandbox execution", () => {
  it("executes only through the authority bound to the exact attestation and request", async () => {
    const sandbox = broker(fullAttestation);
    const negotiated = await sandbox.negotiate(["src/a.ts"]);
    if (negotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    const command = {
      profile: "test",
      executable: "bun",
      arguments: ["test"],
      cwd: ".",
    };
    const executed = await sandbox.execute({
      ...defaultLimits,
      attestation: negotiated.receipt,
      command,
      worktreeRoot: "/tmp/task-roots/worktree",
      writeRoot: "/tmp/task-roots/write",
    });
    expect(executed.status).toBe("executed");
    if (executed.status === "executed") {
      expect(Object.isFrozen(executed.receipt)).toBe(true);
      expect(executed.receipt.stdoutDigest).toHaveLength(64);
      expect(executed.receipt).not.toHaveProperty("stdout");
      expect(executed.receipt).not.toHaveProperty("stderr");
    }
    expect(
      (
        await sandbox.execute({
          ...defaultLimits,
          attestation: { ...negotiated.receipt },
          command,
          worktreeRoot: "/tmp/task-roots/worktree",
          writeRoot: "/tmp/task-roots/write",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await sandbox.execute({
          ...defaultLimits,
          attestation: negotiated.receipt,
          command: { ...command, arguments: ["run", "deploy"] },
          worktreeRoot: "/tmp/task-roots/worktree",
          writeRoot: "/tmp/task-roots/write",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await sandbox.execute({
          ...defaultLimits,
          attestation: negotiated.receipt,
          command,
          worktreeRoot: "/tmp/task-roots/worktree",
          writeRoot: "/tmp/other",
        })
      ).status,
    ).toBe("rejected");
  });

  it("requires disjoint sibling worktree and write roots", async () => {
    const sandbox = broker(fullAttestation);
    const negotiated = await sandbox.negotiate(["src/a.ts"]);
    if (negotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    const command = {
      profile: "read-only",
      executable: "git",
      arguments: ["status", "--short"],
      cwd: ".",
    };
    for (const [worktreeRoot, writeRoot] of [
      ["/tmp/task/worktree", "/tmp/task/worktree/write"],
      ["/tmp/task/write/worktree", "/tmp/task/write"],
      ["/tmp/task/worktree", "/tmp/other/write"],
      ["/tmp/task/worktree", "/tmp/task/worktree"],
    ]) {
      expect(
        await sandbox.execute({
          ...defaultLimits,
          attestation: negotiated.receipt,
          command,
          worktreeRoot,
          writeRoot,
        }),
      ).toEqual({ status: "rejected", code: "ROOT_BINDING_REJECTED" });
    }
    expect(
      (
        await sandbox.execute({
          ...defaultLimits,
          attestation: negotiated.receipt,
          command,
          worktreeRoot: "/tmp/task/worktree",
          writeRoot: "/tmp/task/write",
        })
      ).status,
    ).toBe("executed");
  });

  it("rejects drifted and exceptional execution outcomes", async () => {
    for (const execute of [
      () => {
        throw new Error("sandbox unavailable");
      },
      () => ({
        bindingDigest: "f".repeat(64),
        exitCode: 0,
        stdoutDigest: "0".repeat(64),
        stderrDigest: "0".repeat(64),
        stdoutBytes: 0,
        stderrBytes: 0,
      }),
      (request: SandboxAuthorityExecutionRequest) => ({
        bindingDigest: request.bindingDigest,
        exitCode: 0,
        stdoutDigest: "0".repeat(64),
        stderrDigest: "0".repeat(64),
        stdoutBytes: 1_048_577,
        stderrBytes: 0,
      }),
    ]) {
      const sandbox = broker(fullAttestation, execute);
      const negotiated = await sandbox.negotiate(["src/a.ts"]);
      if (negotiated.status !== "accepted")
        throw new Error("negotiation rejected");
      expect(
        (
          await sandbox.execute({
            ...defaultLimits,
            attestation: negotiated.receipt,
            command: {
              profile: "read-only",
              executable: "git",
              arguments: ["status", "--short"],
              cwd: ".",
            },
            worktreeRoot: "/tmp/task-roots/worktree",
            writeRoot: "/tmp/task-roots/write",
          })
        ).status,
      ).toBe("rejected");
    }
  });

  it("does not accept an attestation issued by another broker", async () => {
    const authority = createSandboxCapabilityAuthority({
      id: "shared-host-probe",
      attest: fullAttestation,
      execute: (request: SandboxAuthorityExecutionRequest) => ({
        bindingDigest: request.bindingDigest,
        exitCode: 0,
        stdoutDigest: "0".repeat(64),
        stderrDigest: "0".repeat(64),
        stdoutBytes: 0,
        stderrBytes: 0,
      }),
    });
    if (authority.status !== "created") throw new Error("authority rejected");
    const first = createPortableSandboxBroker({
      authority: authority.authority,
    });
    const second = createPortableSandboxBroker({
      authority: authority.authority,
    });
    if (first.status !== "created" || second.status !== "created")
      throw new Error("broker rejected");
    const negotiated = await first.broker.negotiate(["src/a.ts"]);
    if (negotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    expect(
      await second.broker.execute({
        attestation: negotiated.receipt,
        command: {
          profile: "test",
          executable: "bun",
          arguments: ["test"],
          cwd: ".",
        },
        worktreeRoot: "/tmp/task-roots/worktree",
        writeRoot: "/tmp/task-roots/write",
      }),
    ).toEqual({ status: "rejected", code: "FORGED_ATTESTATION" });
  });

  it("forwards every approved limit and binds them into the receipt", async () => {
    let observed: SandboxAuthorityExecutionRequest | undefined;
    const sandbox = broker(fullAttestation, (request) => {
      observed = request;
      return {
        bindingDigest: request.bindingDigest,
        exitCode: 0,
        stdoutDigest: "0".repeat(64),
        stderrDigest: "0".repeat(64),
        stdoutBytes: 1_500_000,
        stderrBytes: 0,
      };
    });
    const negotiated = await sandbox.negotiate(["src/a.ts"]);
    if (negotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    const limits = Object.freeze({
      timeoutMilliseconds: 120_000,
      maximumOutputBytes: 2_000_000,
      drainMilliseconds: 2_000,
      signalGraceMilliseconds: 3_000,
    });
    const result = await sandbox.execute({
      ...limits,
      attestation: negotiated.receipt,
      command: {
        profile: "test",
        executable: "bun",
        arguments: ["test"],
        cwd: ".",
      },
      worktreeRoot: "/tmp/task-roots/worktree",
      writeRoot: "/tmp/task-roots/write",
    });
    expect(result.status).toBe("executed");
    expect(observed).toEqual(
      expect.objectContaining({
        timeoutMilliseconds: limits.timeoutMilliseconds,
        maximumOutputBytes: limits.maximumOutputBytes,
        drainMilliseconds: limits.drainMilliseconds,
        signalGraceMilliseconds: limits.signalGraceMilliseconds,
      }),
    );
    if (result.status === "executed") {
      expect(result.receipt.timeoutMilliseconds).toBe(
        limits.timeoutMilliseconds,
      );
      expect(result.receipt.maximumOutputBytes).toBe(limits.maximumOutputBytes);
      expect(result.receipt.drainMilliseconds).toBe(limits.drainMilliseconds);
      expect(result.receipt.signalGraceMilliseconds).toBe(
        limits.signalGraceMilliseconds,
      );
    }
  });

  it("rejects missing, out-of-range, and mismatched execution limits", async () => {
    const sandbox = broker(fullAttestation);
    const negotiated = await sandbox.negotiate(["src/a.ts"]);
    if (negotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    const command = {
      profile: "test" as const,
      executable: "bun" as const,
      arguments: ["test"],
      cwd: ".",
    };
    const base = {
      ...defaultLimits,
      attestation: negotiated.receipt,
      command,
      worktreeRoot: "/tmp/task-roots/worktree",
      writeRoot: "/tmp/task-roots/write",
    };
    const missing = { ...base };
    Reflect.deleteProperty(missing, "signalGraceMilliseconds");
    expect(await sandbox.execute(missing)).toEqual({
      status: "rejected",
      code: "INVALID_EXECUTION_REQUEST",
    });
    expect(await sandbox.execute({ ...base, maximumOutputBytes: 0 })).toEqual({
      status: "rejected",
      code: "INVALID_EXECUTION_REQUEST",
    });
    const mismatchSandbox = broker(fullAttestation, (request) => ({
      bindingDigest: request.bindingDigest,
      timeoutMilliseconds: request.timeoutMilliseconds - 1,
      maximumOutputBytes: request.maximumOutputBytes,
      drainMilliseconds: request.drainMilliseconds,
      signalGraceMilliseconds: request.signalGraceMilliseconds,
      exitCode: 0,
      stdoutDigest: "0".repeat(64),
      stderrDigest: "0".repeat(64),
      stdoutBytes: 0,
      stderrBytes: 0,
    }));
    const mismatchNegotiated = await mismatchSandbox.negotiate(["src/a.ts"]);
    if (mismatchNegotiated.status !== "accepted")
      throw new Error("negotiation rejected");
    expect(
      await mismatchSandbox.execute({
        ...base,
        attestation: mismatchNegotiated.receipt,
      }),
    ).toEqual({ status: "rejected", code: "EXECUTION_MISMATCH" });
  });
});
