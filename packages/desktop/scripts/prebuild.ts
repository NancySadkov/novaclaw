#!/usr/bin/env bun
import { $ } from "bun"

import { enforce } from "../../../script/lib/heavy-guard"
import { resolveChannel } from "./utils"
import { prepareW64devkit } from "./prepare-w64devkit"

// The guard has to bite from BOTH sides. prebuild is the first lifecycle step of every desktop build,
// so refusing here stops a build from piling onto a suite already running. The desktop floor is
// measured rather than inherited from the much larger test suite: on a 16 GB Windows machine the
// production Vite stage completes under a 1.25 GB V8 old-space cap and electron-builder stayed below
// 1 GB, sequentially. The 2.5 GB admission floor therefore protects the host without excluding the
// laptops we ship for; the independent commit-charge ceiling still catches broader system pressure.
enforce("a desktop build", process.argv, { minimumFreeBytes: 2.5 * 1024 ** 3 })

const channel = resolveChannel()
await prepareW64devkit()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../novaclaw && bun script/build-node.ts`
