import process from "node:process";
import { runCommitMessageHook } from "./hook.ts";

process.exitCode = runCommitMessageHook();
