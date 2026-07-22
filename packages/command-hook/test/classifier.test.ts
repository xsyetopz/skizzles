import { describe, expect, it } from "bun:test";
import type { SimpleCommand } from "../src/manage-command-output/contract.ts";
import { simpleCommands } from "../src/manage-command-output/lexer.ts";
import { normalizeCommand } from "../src/manage-command-output/normalize.ts";
import {
  isManagedScript,
  isRecognized,
} from "../src/manage-command-output/policy.ts";

function classifies(script: string): boolean {
  return simpleCommands(script)?.some(isRecognized) ?? false;
}

function command(words: string[]): SimpleCommand {
  return { words, uncertain: words.map(() => false) };
}

describe("managed command output classifier", () => {
  it("lexes separate unquoted top-level commands", () => {
    expect(simpleCommands("echo header; flutter test && cargo check")).toEqual([
      command(["echo", "header"]),
      command(["flutter", "test"]),
      command(["cargo", "check"]),
    ]);
  });

  it("rejects shell syntax outside its supported subset", () => {
    for (const script of [
      "echo 'flutter test'",
      'echo "flutter test"',
      "echo $(flutter test)",
      "echo `flutter test`",
      "echo \\$(flutter test)",
      "echo header; # flutter test\necho footer",
      "cat <<EOF\nflutter test\nEOF",
      "echo $(flutter test)",
      "(flutter test)",
      "{ flutter test; }",
      "if true; then flutter test; fi",
      "while true; do flutter test; done",
      "case x in x) flutter test;; esac",
      "[[ -n value ]] && flutter test",
      "echo okay | flutter test",
      "echo okay & flutter test",
      "cargo test &&",
      "cargo test &&\nbun test",
      "cargo test;\nbun test",
      "flutter test > result.txt",
      "flutter test *.dart",
    ]) {
      expect(simpleCommands(script), script).toBeUndefined();
    }
  });

  it("normalizes only canonical literal tool launcher prefixes", () => {
    expect(
      normalizeCommand(command(["rustup", "run", "nightly", "cargo", "test"])),
    ).toEqual(command(["cargo", "test"]));
    expect(
      normalizeCommand(command(["xcrun", "--sdk", "macosx", "swift", "test"])),
    ).toEqual(command(["swift", "test"]));
    expect(
      normalizeCommand(command(["PATH=/tmp", "cargo", "test"])),
    ).toBeUndefined();
    expect(
      normalizeCommand(command(["env", "PATH=/tmp", "cargo", "test"])),
    ).toBeUndefined();
    expect(
      normalizeCommand(
        command(["xcrun", "--sdk", "/tmp/sdk", "swift", "test"]),
      ),
    ).toBeUndefined();
    expect(
      normalizeCommand(command(["xcrun", "--sdk", "custom", "swift", "test"])),
    ).toBeUndefined();
    expect(
      normalizeCommand(
        command(["xcrun", "--toolchain", "default", "swift", "test"]),
      ),
    ).toBeUndefined();
    expect(
      normalizeCommand(command(["rustup", "run", "custom", "cargo", "test"])),
    ).toBeUndefined();
  });

  it("recognizes high-value build and test commands", () => {
    for (const script of [
      "bun test",
      "bun run test",
      "just test",
      "flutter analyze",
      "dart test",
      "cargo +nightly test --workspace",
      "cargo nextest run",
      "cargo llvm-cov --workspace",
      "xcodebuild -scheme App test",
      "xcrun --sdk iphonesimulator xcodebuild -scheme App build",
      "swift build",
      "gradlew :app:testDebugUnitTest --no-daemon",
      "fvm flutter test",
    ]) {
      expect(classifies(script), script).toBe(true);
    }
  });

  it("recognizes only supported literal Container Lab run prefixes", () => {
    for (const script of [
      "codex-container-lab --owner thread-1 --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- echo hello",
    ]) {
      expect(classifies(script), script).toBe(true);
    }

    for (const script of [
      "codex-container-lab --unknown value run --lab experiment -- echo hello",
      "codex-container-lab --db /tmp/state.sqlite run --lab experiment -- echo hello",
      "codex-container-lab --owner thread health",
      'codex-container-lab --owner "thread" run --lab experiment -- echo hello',
      "/tmp/codex-container-lab run --lab experiment -- echo hello",
      "./codex-container-lab run --lab experiment -- echo hello",
      "bun /tmp/codex-container-lab run --lab experiment -- echo hello",
      "bun codex-container-lab run --lab experiment -- echo hello",
    ]) {
      expect(classifies(script), script).toBe(false);
    }
  });

  it("leaves low-value, unknown, and partial commands alone", () => {
    for (const script of [
      "echo flutter test",
      "dart format .",
      "cargo metadata --format-version 1",
      "cargo fmt --check",
      "swift --version",
      "gradle tasks",
      "./gradlew properties",
      "cargo",
      "cargo +custom test",
    ]) {
      expect(classifies(script), script).toBe(false);
    }
  });

  it("requires every simple command in the rewritten script to be recognized", () => {
    expect(isManagedScript("flutter test && cargo check; bun test")).toBe(true);
    expect(isManagedScript("echo header; flutter test")).toBe(false);
    expect(isManagedScript("flutter test; rm -rf target")).toBe(false);
  });
});
