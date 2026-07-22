import { describe, expect, it } from "bun:test";
import {
  createPortableSandboxBroker,
  createSandboxCapabilityAuthority,
} from "../../src/sandbox/capabilities.ts";
import { broker, fullAttestation } from "./support.ts";

describe("portable OS sandbox attestation", () => {
  it("rejects attest-only authorities that cannot enforce execution", () => {
    expect(
      createSandboxCapabilityAuthority({
        id: "attest-only",
        attest: fullAttestation,
      }).status,
    ).toBe("rejected");
  });

  it("accepts only an exact capability-attested target set", async () => {
    const result = await broker(fullAttestation).negotiate([
      "src/b.ts",
      "src/a.ts",
    ]);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.receipt.writePaths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.receipt.readOnlyWorktree).toBe(true);
      expect(result.receipt.networkDisabled).toBe(true);
      expect(result.receipt.boundedProcessTree).toBe(true);
      expect(Object.isFrozen(result.receipt)).toBe(true);
    }
  });

  it("rejects each missing or false isolation capability", async () => {
    for (const field of [
      "readOnlyWorktree",
      "networkDisabled",
      "boundedProcessTree",
    ]) {
      const missing = fullAttestation(["src/a.ts"]);
      delete missing[field];
      expect((await broker(() => missing).negotiate(["src/a.ts"])).status).toBe(
        "rejected",
      );
      expect(
        (
          await broker(() => ({
            ...fullAttestation(["src/a.ts"]),
            [field]: false,
          })).negotiate(["src/a.ts"])
        ).status,
      ).toBe("rejected");
    }
  });

  it("fails closed for unavailable or insufficient capabilities", async () => {
    expect(
      await broker(() => {
        throw new Error("unsupported");
      }).negotiate(["src/a.ts"]),
    ).toEqual({ status: "rejected", code: "CAPABILITY_UNAVAILABLE" });
    expect(
      (
        await broker((paths) => ({
          mechanism: "docker",
          writePaths: paths,
          deniesUndeclaredWrites: true,
          deniesSystemControl: true,
          readOnlyWorktree: true,
          networkDisabled: true,
          boundedProcessTree: true,
          evidence: "unproven-docker",
        })).negotiate(["src/a.ts"])
      ).status,
    ).toBe("rejected");
    expect(
      (
        await broker((paths) => ({
          mechanism: "apparmor",
          writePaths: paths,
          deniesUndeclaredWrites: false,
          deniesSystemControl: true,
          readOnlyWorktree: true,
          networkDisabled: true,
          boundedProcessTree: true,
          evidence: "profile-loaded",
        })).negotiate(["src/a.ts"])
      ).status,
    ).toBe("rejected");
    expect(
      (
        await broker(() => ({
          mechanism: "seatbelt",
          writePaths: ["src/other.ts"],
          deniesUndeclaredWrites: true,
          deniesSystemControl: true,
          readOnlyWorktree: true,
          networkDisabled: true,
          boundedProcessTree: true,
          evidence: "compiled-profile",
        })).negotiate(["src/a.ts"])
      ).status,
    ).toBe("rejected");
  });

  it("rejects forged authorities and traversal targets", async () => {
    expect(
      createPortableSandboxBroker({ authority: { id: "forged" } }).status,
    ).toBe("rejected");
    expect(
      (
        await broker((paths) => ({
          mechanism: "landlock",
          writePaths: paths,
          deniesUndeclaredWrites: true,
          deniesSystemControl: true,
          readOnlyWorktree: true,
          networkDisabled: true,
          boundedProcessTree: true,
          evidence: "kernel-probe",
        })).negotiate(["../escape"])
      ).status,
    ).toBe("rejected");
  });
});
