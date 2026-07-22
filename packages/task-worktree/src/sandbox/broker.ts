import { digestJson, hasOnlyKeys, isPlainDataRecord } from "../policy/value.ts";
import { attestationStates, negotiateSandbox } from "./attestation.ts";
import { sandboxAuthorityConfig } from "./authority.ts";
import { authorizeStructuredCommand } from "./command-policy.ts";
import type {
  PortableSandboxBroker,
  SandboxExecutionResult,
} from "./contract.ts";
import {
  parseBoundRoot,
  parseExecutionLimits,
  parseExecutionOutcome,
  rootsAreOwnedSiblings,
} from "./execution.ts";

export function createPortableSandboxBroker(
  input: unknown,
):
  | Readonly<{ status: "created"; broker: PortableSandboxBroker }>
  | Readonly<{ status: "rejected"; code: "INVALID_SANDBOX_AUTHORITY" }> {
  if (!(isPlainDataRecord(input) && hasOnlyKeys(input, ["authority"]))) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SANDBOX_AUTHORITY",
    });
  }
  const authorityConfig = sandboxAuthorityConfig(input["authority"]);
  if (authorityConfig === undefined) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SANDBOX_AUTHORITY",
    });
  }
  const brokerToken = Object.freeze({});
  return Object.freeze({
    status: "created",
    broker: Object.freeze({
      negotiate: async (pathInput: unknown) =>
        await negotiateSandbox(authorityConfig, brokerToken, pathInput),
      execute: async (
        executionInput: unknown,
      ): Promise<SandboxExecutionResult> => {
        if (
          !(
            isPlainDataRecord(executionInput) &&
            hasOnlyKeys(executionInput, [
              "attestation",
              "command",
              "timeoutMilliseconds",
              "maximumOutputBytes",
              "drainMilliseconds",
              "signalGraceMilliseconds",
              "worktreeRoot",
              "writeRoot",
            ])
          )
        ) {
          return Object.freeze({
            status: "rejected",
            code: "INVALID_EXECUTION_REQUEST",
          });
        }
        const attestation = executionInput["attestation"];
        const state =
          typeof attestation === "object" && attestation !== null
            ? attestationStates.get(attestation)
            : undefined;
        if (
          state === undefined ||
          state.authority !== authorityConfig ||
          state.brokerToken !== brokerToken
        ) {
          return Object.freeze({
            status: "rejected",
            code: "FORGED_ATTESTATION",
          });
        }
        const limits = parseExecutionLimits(executionInput);
        if (limits === null) {
          return Object.freeze({
            status: "rejected",
            code: "INVALID_EXECUTION_REQUEST",
          });
        }
        const worktreeRoot = parseBoundRoot(executionInput["worktreeRoot"]);
        const writeRoot = parseBoundRoot(executionInput["writeRoot"]);
        if (
          worktreeRoot === null ||
          writeRoot === null ||
          !rootsAreOwnedSiblings(worktreeRoot, writeRoot)
        ) {
          return Object.freeze({
            status: "rejected",
            code: "ROOT_BINDING_REJECTED",
          });
        }
        const commandResult = authorizeStructuredCommand(
          executionInput["command"],
        );
        if (commandResult.status !== "accepted") {
          return Object.freeze({
            status: "rejected",
            code: "COMMAND_REJECTED",
          });
        }
        const bindingBody = {
          attestationDigest: state.attestationDigest,
          writePaths: state.writePaths,
          command: commandResult.command,
          worktreeRoot,
          writeRoot,
          ...limits,
        } as const;
        const bindingDigest = digestJson(bindingBody);
        const request = Object.freeze({ ...bindingBody, bindingDigest });
        let rawOutcome: unknown;
        try {
          rawOutcome = await authorityConfig.execute(request);
        } catch {
          return Object.freeze({
            status: "rejected",
            code: "EXECUTION_UNAVAILABLE",
          });
        }
        const outcome = parseExecutionOutcome(
          rawOutcome,
          bindingDigest,
          limits,
        );
        if (outcome === null) {
          return Object.freeze({
            status: "rejected",
            code: "EXECUTION_MISMATCH",
          });
        }
        const receiptBody = {
          attestationDigest: state.attestationDigest,
          ...limits,
          ...outcome,
        } as const;
        return Object.freeze({
          status: "executed",
          receipt: Object.freeze({
            ...receiptBody,
            outcomeDigest: digestJson(receiptBody),
          }),
        });
      },
    }),
  });
}
