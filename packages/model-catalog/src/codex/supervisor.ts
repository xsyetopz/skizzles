import process from "node:process";

const CODEX_SUPERVISOR_PROTOCOL_VERSION = 1;

const CODEX_SUPERVISOR_SOURCE = String.raw`
const protocolVersion = ${CODEX_SUPERVISOR_PROTOCOL_VERSION};
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 2_147_483_647);
const publish = async (message) => {
  try {
    await process.send?.({ version: protocolVersion, ...message });
  } catch {}
};
const encoded = Bun.argv[1];
let command;
try {
  const parsed = JSON.parse(decodeURIComponent(encoded));
  const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
  if (
    keys.length !== 2 ||
    typeof parsed.binary !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((value) => typeof value === "string")
  ) {
    throw new Error("invalid command");
  }
  command = parsed;
} catch {
  await publish({ type: "supervisor-error" });
}
if (command !== undefined) {
  try {
    const tool = Bun.spawn([command.binary, ...command.args], {
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    await publish({ type: "ready" });
    tool.exited.then(
      (exitCode) => publish({ type: "exited", exitCode }),
      () => publish({ type: "tool-error" }),
    );
  } catch {
    await publish({ type: "spawn-error" });
  }
}
`;

type CodexSupervisorMessage =
  | {
      readonly type: "ready";
      readonly version: typeof CODEX_SUPERVISOR_PROTOCOL_VERSION;
    }
  | {
      readonly type: "spawn-error" | "supervisor-error" | "tool-error";
      readonly version: typeof CODEX_SUPERVISOR_PROTOCOL_VERSION;
    }
  | {
      readonly exitCode: number;
      readonly type: "exited";
      readonly version: typeof CODEX_SUPERVISOR_PROTOCOL_VERSION;
    };

type FinalCodexSupervisorMessage = Exclude<
  CodexSupervisorMessage,
  { readonly type: "ready" }
>;

interface CodexSupervisorProtocol {
  readonly final: Promise<FinalCodexSupervisorMessage>;
  readonly receive: (message: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexSupervisorMessage(
  value: unknown,
): value is CodexSupervisorMessage {
  if (
    !isRecord(value) ||
    value["version"] !== CODEX_SUPERVISOR_PROTOCOL_VERSION ||
    typeof value["type"] !== "string"
  ) {
    return false;
  }
  if (
    value["type"] === "ready" ||
    value["type"] === "spawn-error" ||
    value["type"] === "supervisor-error" ||
    value["type"] === "tool-error"
  ) {
    return Object.keys(value).length === 2;
  }
  return (
    value["type"] === "exited" &&
    Object.keys(value).length === 3 &&
    Number.isSafeInteger(value["exitCode"])
  );
}

function codexSupervisorProtocol(): CodexSupervisorProtocol {
  const final = Promise.withResolvers<FinalCodexSupervisorMessage>();
  let state: "final" | "pending" | "ready" = "pending";
  const reject = (): void => {
    state = "final";
    final.reject(new Error("Codex supervisor protocol failed"));
  };
  const receive = (message: unknown): void => {
    if (state === "final") return;
    if (!isCodexSupervisorMessage(message)) {
      reject();
      return;
    }
    if (message.type === "ready") {
      if (state !== "pending") {
        reject();
        return;
      }
      state = "ready";
      return;
    }
    if (message.type === "spawn-error" || message.type === "supervisor-error") {
      if (state !== "pending") {
        reject();
        return;
      }
    } else if (state !== "ready") {
      reject();
      return;
    }
    state = "final";
    final.resolve(message);
  };
  return { final: final.promise, receive };
}

function codexSupervisorCommand(
  binary: string,
  args: readonly string[],
): string[] {
  return [
    process.execPath,
    "--eval",
    CODEX_SUPERVISOR_SOURCE,
    encodeURIComponent(JSON.stringify({ binary, args })),
  ];
}

export {
  codexSupervisorCommand,
  codexSupervisorProtocol,
  type FinalCodexSupervisorMessage,
};
