import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createRunnerFixture } from "./runner-fixture.ts";

const ownerFixture = createRunnerFixture();
const peerFixture = createRunnerFixture();
afterEach(() => {
  ownerFixture.cleanupTemporaryDirectories();
  peerFixture.cleanupTemporaryDirectories();
});

describe("runner fixture ownership", () => {
  it("keeps independent importer registries isolated during overlapping lifetimes", () => {
    const ownerDirectory = ownerFixture.temporaryDirectory();
    const peerDirectory = peerFixture.temporaryDirectory();

    ownerFixture.cleanupTemporaryDirectories();

    expect(existsSync(ownerDirectory)).toBe(false);
    expect(existsSync(peerDirectory)).toBe(true);

    peerFixture.cleanupTemporaryDirectories();
    expect(existsSync(peerDirectory)).toBe(false);
  });
});
