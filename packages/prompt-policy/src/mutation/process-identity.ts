import { readFile } from "node:fs/promises";
import process from "node:process";
import type { ProcessIdentityProvider } from "../lifecycle/contract.ts";
import { PromptLayerError } from "../lifecycle/contract.ts";
import { isNodeError } from "../repository-boundary.ts";

const WHITESPACE = /\s+/u;
const ALL_WHITESPACE = /\s+/gu;
const LINE_BREAK = /[\r\n]/u;
const DARWIN_PS_LSTART =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/u;
const DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const defaultProcessIdentityProvider: ProcessIdentityProvider = {
  async processStartIdentity(pid: number): Promise<string | undefined> {
    if (process.platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd < 0) {
          return undefined;
        }
        const fields = stat
          .slice(commandEnd + 1)
          .trim()
          .split(WHITESPACE);
        const startTicks = fields[19];
        return startTicks === undefined ? undefined : `linux:${startTicks}`;
      } catch {
        return undefined;
      }
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
        {
          env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      if (result.exitCode !== 0) {
        return undefined;
      }
      return normalizeDarwinProcessStartOutput(result.stdout.toString());
    }
    return undefined;
  },
};

export function normalizeDarwinProcessStartOutput(
  output: string,
): string | undefined {
  const normalized = output.trim().replace(ALL_WHITESPACE, " ");
  const match = DARWIN_PS_LSTART.exec(normalized);
  if (match === null) {
    return undefined;
  }
  const [
    ,
    weekdayName,
    monthName,
    dayText,
    hourText,
    minuteText,
    secondText,
    yearText,
  ] = match;
  if (
    weekdayName === undefined ||
    monthName === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    yearText === undefined
  ) {
    return undefined;
  }
  const weekday = DARWIN_WEEKDAYS.indexOf(weekdayName);
  const month = DARWIN_MONTHS.indexOf(monthName);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const year = Number(yearText);
  if (weekday < 0 || month < 0) {
    return undefined;
  }
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epochMs);
  if (
    !Number.isFinite(epochMs) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== weekday
  ) {
    return undefined;
  }
  return `darwin:${epochMs / 1000}`;
}

export function validProcessStartIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !LINE_BREAK.test(value)
  );
}

export async function processOwnerState(
  owner: { pid: number; processStartIdentity: string },
  provider: ProcessIdentityProvider,
): Promise<"live" | "stale" | "unknown"> {
  if (!processExists(owner.pid)) {
    return "stale";
  }
  let actual: string | undefined;
  try {
    actual = await provider.processStartIdentity(owner.pid);
  } catch {
    return "unknown";
  }
  if (!validProcessStartIdentity(actual)) {
    return "unknown";
  }
  return actual === owner.processStartIdentity ? "live" : "stale";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export async function assertOwnerIsStale(
  owner: { pid: number; processStartIdentity: string; operation: string },
  provider: ProcessIdentityProvider,
): Promise<void> {
  const state = await processOwnerState(owner, provider);
  if (state === "stale") {
    return;
  }
  if (state === "unknown") {
    throw new PromptLayerError(
      `Cannot verify process-start identity for pid ${owner.pid}; refusing stale-lock recovery.`,
    );
  }
  throw new PromptLayerError(
    `Prompt mutation is owned by live pid ${owner.pid} (${owner.operation}); refusing concurrent recovery.`,
  );
}
