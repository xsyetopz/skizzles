import { advanceBatch, startBatch } from "./advance.ts";
import type {
  SourceEngineering,
  SourceEngineeringAdvanceResult,
  SourceEngineeringCreationResult,
  SourceEngineeringFailureCode,
  SourceEngineeringStartResult,
} from "./contract.ts";
import { SourceEngineeringState } from "./cursor.ts";
import { describeEngineering } from "./describe.ts";
import { objectValue, parseEngineConfig } from "./input.ts";
import { validateBatch, verifyPrepared } from "./validate.ts";

const authenticEngines = new WeakSet<object>();

export function createSourceEngineering(
  input: unknown,
): SourceEngineeringCreationResult {
  let config: ReturnType<typeof parseEngineConfig>;
  try {
    config = parseEngineConfig(input);
  } catch {
    return rejectedCreation();
  }
  if (config === undefined) return rejectedCreation();

  const state = new SourceEngineeringState();
  const validationCursors = new WeakSet<object>();
  const sourceEngineering: SourceEngineering = Object.freeze({
    describe: (value: unknown) => describeEngineering(config, state, value),
    start: (value: unknown): SourceEngineeringStartResult => {
      try {
        const result = startBatch(config, state, value);
        rememberValidationCursor(result, validationCursors);
        return result;
      } catch {
        return rejected("INVALID_INPUT");
      }
    },
    advance: async (
      value: unknown,
    ): Promise<SourceEngineeringAdvanceResult> => {
      try {
        const cursor = cursorFromAdvanceInput(value);
        if (cursor !== undefined && validationCursors.has(cursor)) {
          const consumed = state.consumeCursor(cursor);
          if (consumed === "replayed") return rejected("CURSOR_REPLAYED");
          if (consumed === undefined) return rejected("CURSOR_FORGED");
          return await validateBatch(config, state, consumed.batch);
        }
        const result = await advanceBatch(config, state, value);
        rememberValidationCursor(result, validationCursors);
        return result;
      } catch {
        return rejected("INVALID_INPUT");
      }
    },
    verify: (value: unknown) => verifyPrepared(state, value),
  });
  authenticEngines.add(sourceEngineering);
  return Object.freeze({ status: "created", sourceEngineering });
}

export function isSourceEngineering(
  value: unknown,
): value is SourceEngineering {
  return (
    typeof value === "object" && value !== null && authenticEngines.has(value)
  );
}

function rememberValidationCursor(
  result: SourceEngineeringStartResult | SourceEngineeringAdvanceResult,
  cursors: WeakSet<object>,
): void {
  if (result.status === "ready" && result.next.kind === "validate") {
    cursors.add(result.cursor);
  }
}

function cursorFromAdvanceInput(value: unknown): object | undefined {
  if (!Object.isFrozen(value)) return;
  const input = objectValue(value);
  if (input === undefined) return;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== "cursor") return;
  const descriptor = Object.getOwnPropertyDescriptor(input, "cursor");
  if (descriptor === undefined || !("value" in descriptor)) return;
  return objectValue(descriptor.value);
}

function rejectedCreation(): SourceEngineeringCreationResult {
  return Object.freeze({ status: "rejected", code: "INVALID_CONFIG" });
}

function rejected(code: SourceEngineeringFailureCode): Readonly<{
  status: "rejected";
  code: SourceEngineeringFailureCode;
}> {
  return Object.freeze({ status: "rejected", code });
}
