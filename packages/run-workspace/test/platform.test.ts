// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import { parseDarwinBootTime, parseLinuxStartTicks } from "../src/platform.ts";

describe("process identity parsers", () => {
  it("extracts Linux start ticks after a command containing parentheses", () => {
    const intervening = Array.from({ length: 18 }, (_, index) =>
      String(index + 1),
    );
    const stat = `77 (worker ) name) S ${intervening.join(" ")} 4242 0 0`;
    expect(parseLinuxStartTicks(stat)).toBe("4242");
    expect(parseLinuxStartTicks("malformed")).toBeUndefined();
  });

  it("binds Darwin identity to parsed boot time", () => {
    expect(
      parseDarwinBootTime(
        "{ sec = 1750000000, usec = 123456 } Mon Jan 1 00:00:00 2026",
      ),
    ).toBe("1750000000.123456");
    expect(parseDarwinBootTime("unavailable")).toBeUndefined();
  });
});
