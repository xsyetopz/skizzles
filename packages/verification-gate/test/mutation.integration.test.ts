import { describe, expect, it } from "bun:test";
import process from "node:process";
import { digestValue, type VerificationDigest } from "../src/digest.ts";
import type { VerificationAuthorityRequest } from "../src/index.ts";
import { createGateFixture } from "./fixture.ts";

describe("real logical mutation engine fixture", () => {
  it("observes a weak-test operator mutant survive and strengthened tests kill it", async () => {
    let strengthened = false;
    const fixture = createGateFixture(async (request) =>
      runOperatorMutation(request, strengthened),
    );

    const weak = await fixture.gate.evaluate(fixture.input);
    expect(weak).toMatchObject({
      status: "rejected",
      code: "MUTATION_SURVIVED",
    });
    expect(fixture.calls.at(-1)).toBe("reviewer");

    strengthened = true;
    fixture.calls.length = 0;
    const strong = await fixture.gate.evaluate(fixture.input);
    expect(strong).toMatchObject({ status: "accepted" });
    expect(fixture.calls.at(-1)).toBe("reviewer");
  });
});

async function runOperatorMutation(
  request: VerificationAuthorityRequest,
  strengthened: boolean,
): Promise<unknown> {
  const payload = request.payload as Readonly<{
    inventory: readonly Readonly<{ mutantId: VerificationDigest }>[];
    inventoryDigest: VerificationDigest;
  }>;
  const cases = strengthened ? [9, 10, 11] : [9, 11];
  const program = [
    `const cases = ${JSON.stringify(cases)};`,
    "const baseline = (value) => value >= 10;",
    "const mutant = (value) => value > 10;",
    "process.exit(cases.every((value) => baseline(value) === mutant(value)) ? 0 : 1);",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", program], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: Object.freeze({}),
  });
  const exitCode = await child.exited;
  const outcome = exitCode === 0 ? "survived" : "killed";
  return Object.freeze({
    status: "valid",
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue(`real-engine-${outcome}`),
    candidateManifestDigest: request.bindings.candidateManifestDigest,
    inventoryDigest: payload.inventoryDigest,
    profileReceiptDigest: digestValue("profile-mutation"),
    outcomes: Object.freeze(
      payload.inventory.map(({ mutantId }) =>
        Object.freeze({
          mutantId,
          outcome,
          evidenceDigest: digestValue(`real-operator-${outcome}`),
        }),
      ),
    ),
  });
}
