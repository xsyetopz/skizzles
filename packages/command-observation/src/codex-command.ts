#!/usr/bin/env bun

import process from "node:process";
import { dispatchCommand } from "./codex-command/cli.ts";

process.exit(await dispatchCommand(process.argv.slice(2)));
