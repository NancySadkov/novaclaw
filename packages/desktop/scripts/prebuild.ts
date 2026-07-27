#!/usr/bin/env bun
import { $ } from "bun"

import { enforce } from "../../../script/lib/heavy-guard"
import { resolveChannel } from "./utils"

// The guard has to bite from BOTH sides. prebuild is the first step of every desktop build
// (build-desktop.bat / build-desktop-release.bat both start here), so refusing here is what stops a
// build from piling onto a suite that is already running — the reverse of the case test.ts catches.
enforce("a desktop build")

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../novaclaw && bun script/build-node.ts`
