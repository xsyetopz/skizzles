import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DockerRunner, DockerSpawnOptions } from "../compose/docker-runner";
import type { CommandResult, RunOptions } from "../execution/process";
import { runCommand } from "../execution/process";
import { ownerKey } from "../storage/state";

export class RecordingDocker implements DockerRunner {
  calls: string[][] = [];
  runCalls: Array<{ args: string[]; options?: RunOptions }> = [];
  spawnCalls: Array<{ args: string[]; options?: DockerSpawnOptions }> = [];
  child?: ChildProcessWithoutNullStreams;
  model: unknown = { services: { dev: {} } };
  async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) return { code: 0, stdout: Buffer.from(JSON.stringify(this.model)), stderr: Buffer.alloc(0) };
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  spawn(args: string[], options?: DockerSpawnOptions): ChildProcessWithoutNullStreams {
    this.calls.push(args);
    this.spawnCalls.push({ args, options });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    this.child = child;
    return child;
  }
}

export class SecretDiagnosticDocker extends RecordingDocker {
  constructor(private readonly sentinel: string) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("config")) {
      this.calls.push(args);
      this.runCalls.push({ args, options });
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`secret diagnostic: ${this.sentinel}`) };
    }
    return await super.run(args, options);
  }
}

export class InterruptingDocker extends RecordingDocker {
  constructor(private readonly controller: AbortController) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (args.includes("up")) {
      this.calls.push(args);
      this.controller.abort("SIGTERM");
      throw new Error("docker compose up aborted");
    }
    return await super.run(args, options);
  }
}

export class DestructiveDocker extends RecordingDocker {
  private listed = false;
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "ps" && args[1] === "-aq" && !this.listed) {
      this.listed = true;
      return { code: 0, stdout: Buffer.from("container-1\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      Object.assign(this.child!, { exitCode: 137 });
      this.child!.emit("close", 137);
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

export class AlternatesInspectingDocker extends RecordingDocker {
  alternatesAtFirstCall?: string[];

  constructor(
    private readonly runtimeRoot: string,
    private readonly owner: string,
  ) {
    super();
  }

  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    if (!this.alternatesAtFirstCall) {
      const labs = await readdir(join(this.runtimeRoot, ownerKey(this.owner)));
      const workspace = join(this.runtimeRoot, ownerKey(this.owner), labs[0]!, "workspace");
      const commonGit = (await runCommand("git", [
        "-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir",
      ])).stdout.toString().trim();
      const info = join(commonGit, "objects", "info");
      this.alternatesAtFirstCall = [];
      for (const name of ["alternates", "http-alternates"]) {
        if (await Bun.file(join(info, name)).exists()) this.alternatesAtFirstCall.push(name);
      }
    }
    return await super.run(args, options);
  }
}

export class ComposeFailureServiceDocker extends RecordingDocker {
  constructor(private readonly sentinel: string, private readonly exitCode = 23, private readonly failureText?: string) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ services: { dev: {} } })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(this.failureText ?? `Compose failed ${this.sentinel} /private/tmp/project`) };
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify([
        { Service: "dev", State: "exited", Health: "unhealthy", ExitCode: this.exitCode, ID: "private-container-id", Project: "ccl-private" },
      ])), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

export class LargeComposeFailureServiceDocker extends RecordingDocker {
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ services: { dev: {} } })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      const script = [
        "const { writeSync } = require('node:fs');",
        "const prefix = 'BUILD_EXPORT_PREFIX\\n'.repeat(300_000);",
        "writeSync(1, prefix);",
        "writeSync(2, prefix);",
        "writeSync(2, '\\nTERMINAL_DEV_EXIT_17\\nTERMINAL_COMPOSE_FAILURE_DEV\\n');",
        "process.exitCode = 1;",
      ].join(" ");
      return await runCommand(process.execPath, ["-e", script], options);
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify([
        { Service: "dev", State: "exited", ExitCode: 17 },
      ])), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

export class ServiceLogsDocker extends RecordingDocker {
  constructor(
    private readonly statuses: unknown[],
    private readonly logs: Record<string, string | CommandResult | Error | ((options?: RunOptions) => CommandResult)>,
    private readonly modelServices: string[] = ["dev"],
    private readonly lifecycle = "LIFECYCLE_MARKER",
  ) { super(); }
  override async run(args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push(args);
    this.runCalls.push({ args, options });
    if (args.includes("config")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify({
        services: Object.fromEntries(this.modelServices.map((service) => [service, {}])),
      })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("up")) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(this.lifecycle) };
    }
    if (args.includes("ps") && args.includes("--all")) {
      return { code: 0, stdout: Buffer.from(JSON.stringify(this.statuses)), stderr: Buffer.alloc(0) };
    }
    if (args.includes("logs")) {
      const service = args.at(-1)!;
      const log = this.logs[service] ?? "";
      if (log instanceof Error) throw log;
      if (typeof log === "function") return log(options);
      if (typeof log === "string") return { code: 0, stdout: Buffer.from(log), stderr: Buffer.alloc(0) };
      return log;
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}
