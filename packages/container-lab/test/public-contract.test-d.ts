// biome-ignore lint/correctness/noUnresolvedImports: This type contract intentionally resolves the package's declared self-reference export.
import type { ContainerLabService, RunOutput } from "@skizzles/container-lab";

type Assert<Condition extends true> = Condition;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? true : false) extends <
    Value,
  >() => Value extends Right ? true : false
    ? true
    : false;

export type ContainerLabValueExports = Assert<
  Equal<
    keyof typeof import("@skizzles/container-lab"),
    | "ContainerLabService"
    | "createPhysicalIntegrationAuthority"
    | "recoverLabSync"
  >
>;

export type ContainerLabServiceHealth = Assert<
  Equal<
    Awaited<ReturnType<ContainerLabService["health"]>>,
    { ok: true; dockerAvailable: boolean; labs: number }
  >
>;

export type ContainerLabRunOutput = Assert<
  Equal<
    RunOutput,
    {
      stdout: (chunk: Buffer) => void;
      stderr: (chunk: Buffer) => void;
      stdin?: NodeJS.ReadableStream;
    }
  >
>;
