#!/usr/bin/env bun

import { dispatchCommand } from "./codex-command/cli.ts";

process.exit(await dispatchCommand(process.argv.slice(2)));
