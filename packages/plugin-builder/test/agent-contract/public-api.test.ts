import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as stagingApi from "@skizzles/plugin-builder";

import {
  ContractRejection,
  evaluateAgentContract,
  type JsonValue,
} from "@skizzles/plugin-builder/agent-contract";
import {
  assertArray,
  assertRecord,
  parseJsonAsset,
} from "../../src/agent-contract/json/value.ts";
import { cloneJson, requiredValue } from "./support.ts";

const TRUST_CORPUS = join(
  import.meta.dir,
  "../../../../skills/fourth-wall/fixtures/trust-boundary-incidents.json",
);

describe("declared agent-contract package API", () => {
  it("keeps the staging facade and evaluation facade intentionally disjoint", async () => {
    const contractApi = await import("@skizzles/plugin-builder/agent-contract");
    expect(Object.keys(contractApi).sort()).toEqual([
      "ContractRejection",
      "evaluateAgentContract",
    ]);
    expect(Object.keys(stagingApi).sort()).toEqual([
      "PackagingError",
      "buildPlugin",
      "checkPlugin",
      "compareTrees",
      "packagePaths",
      "stagePlugin",
    ]);
    expect("evaluateAgentContract" in stagingApi).toBe(false);
  });

  it("evaluates a published control through the declared production boundary", async () => {
    const corpus = await loadCorpus();
    const control = assertArray(corpus["controls"], "controls")
      .map((value) => assertRecord(value, "control"))
      .find((value) => value["id"] === "FW-CONTEXT-CONTROL");
    if (control === undefined) {
      throw new Error("Missing context control.");
    }
    const input = requiredValue(control["input"]);
    const options = requiredValue(corpus["evaluationOptions"]);
    expect(() =>
      evaluateAgentContract("context-envelope", input, options),
    ).not.toThrow();

    const rejected = cloneJson(input);
    const property = assertRecord(
      requiredValue(
        assertArray(
          assertRecord(rejected, "input")["properties"],
          "properties",
        )[0],
      ),
      "property",
    );
    assertRecord(property["policy"], "policy")["digest"] = "0".repeat(64);
    expect(() =>
      evaluateAgentContract("context-envelope", rejected, options),
    ).toThrow(ContractRejection);
    try {
      evaluateAgentContract("context-envelope", rejected, options);
    } catch (error) {
      if (!(error instanceof ContractRejection)) {
        throw error;
      }
      expect(error.code).toBe("POLICY_MISMATCH");
    }
  });

  it("parses untrusted option JSON instead of exposing parsed internals", async () => {
    const corpus = await loadCorpus();
    const control = assertRecord(
      requiredValue(assertArray(corpus["controls"], "controls")[0]),
      "control",
    );
    const options = cloneJson(requiredValue(corpus["evaluationOptions"]));
    assertRecord(options, "options")["undeclared"] = true;

    try {
      evaluateAgentContract(
        "context-envelope",
        requiredValue(control["input"]),
        options,
      );
      throw new Error("Expected public evaluation to reject invalid options.");
    } catch (error) {
      if (!(error instanceof ContractRejection)) {
        throw error;
      }
      expect(error.code).toBe("INSTANCE_SHAPE");
    }
  });
});

async function loadCorpus(): Promise<Record<string, JsonValue>> {
  return assertRecord(
    parseJsonAsset(await readFile(TRUST_CORPUS), "public API corpus"),
    "public API corpus",
  );
}
