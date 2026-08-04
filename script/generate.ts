#!/usr/bin/env bun

import { $ } from "bun"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const openapi = path.join(root, "packages", "sdk", "openapi.json")

// Refresh the ONE committed contract before generating the client. The old order built the SDK
// from yesterday's openapi.json and only then replaced that file, so one pass could leave generated
// code a full revision behind while appearing successful.
await $`bun dev generate > ${openapi}`.cwd(path.join(root, "packages", "novaclaw"))
await $`bun ./packages/sdk/js/script/build.ts`.cwd(root)

// Codegen owns these artifacts, not every source file in a dirty worktree. A whole-repository
// prettier pass made regeneration take minutes and could fail on unrelated in-progress work.
await $`bun run prettier --ignore-unknown --write packages/sdk/openapi.json packages/sdk/js/src/v2/gen`.cwd(root)
