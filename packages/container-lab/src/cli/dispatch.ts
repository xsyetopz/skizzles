import process from "node:process";
import { ContainerLabService } from "../lab/orchestrator.ts";
import {
  CliUsageError,
  integerFlag,
  parseCommandFlags,
  requireNoArguments,
  syncDirection,
} from "./arguments.ts";

export async function dispatchCliCommand(
  service: ContainerLabService,
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const [noun, verb, ...rest] = args;
  if (!noun) {
    throw new CliUsageError("a command is required; use --help");
  }
  if (noun === "health") {
    requireNoArguments(
      [verb, ...rest].filter((value): value is string => value !== undefined),
    );
    return await service.health();
  }
  if (noun === "lab") {
    if (verb === "create") {
      const flags = parseCommandFlags(rest, new Set(["--name", "--source"]));
      return await service.createLab(
        flags.one("--name") ?? "lab",
        flags.one("--source") ?? process.cwd(),
        signal,
      );
    }
    if (verb === "list") {
      requireNoArguments(rest);
      return await service.listLabs();
    }
    if (verb === "status") {
      const flags = parseCommandFlags(rest, new Set(["--lab"]));
      return await service.labStatus(flags.required("--lab"));
    }
    if (verb === "destroy") {
      const flags = parseCommandFlags(rest, new Set(["--lab"]));
      return await service.destroyLab(flags.required("--lab"));
    }
    if (verb === "destroy-all") {
      requireNoArguments(rest);
      return await service.destroyAll();
    }
    throw new CliUsageError(
      "lab requires create, list, status, destroy, or destroy-all",
    );
  }
  if (noun === "logs") {
    const remaining = verb === undefined ? rest : [verb, ...rest];
    const flags = parseCommandFlags(
      remaining,
      new Set(["--lab", "--service", "--tail-lines"]),
    );
    return await service.logs(
      flags.required("--lab"),
      flags.required("--service"),
      integerFlag(flags.one("--tail-lines"), "--tail-lines", 100),
    );
  }
  if (noun === "sync") {
    if (verb === "preview") {
      const flags = parseCommandFlags(rest, new Set(["--lab", "--direction"]));
      return await service.preview(
        flags.required("--lab"),
        syncDirection(flags.required("--direction")),
      );
    }
    if (verb === "apply") {
      const flags = parseCommandFlags(
        rest,
        new Set(["--lab", "--direction", "--token"]),
      );
      return await service.apply(
        flags.required("--lab"),
        syncDirection(flags.required("--direction")),
        flags.required("--token"),
      );
    }
    throw new CliUsageError("sync requires preview or apply");
  }
  throw new CliUsageError(`unknown command: ${noun}`);
}
