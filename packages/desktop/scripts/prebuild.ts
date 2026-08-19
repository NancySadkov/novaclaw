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

/**
 * The native host module, which `electron-builder.config.ts` copies out of `packages/host/build/`
 * into `resources/host/`. Built here because that directory must EXIST before packaging — an
 * `extraResources` entry pointing at a missing source is the difference between a packaged watcher
 * that works and one that is silently absent.
 *
 * 🔴 **FATAL on Windows, a warning elsewhere** (owner, 2026-08-19: *"so there will be no further
 * confusion"*). The soft catch is why the 0.1.63 release build packaged a `host.dll` from a week
 * earlier without anyone noticing: `build.ts` could not find a compiler, this line shrugged, and the
 * word WARNING scrolled past in a 4,000-line log. On Windows there is now nothing left to be
 * tolerant of — `prepareW64devkit()` ran on the line above and `build.ts` provisions the pinned kit
 * itself, so a failure here means the toolchain is genuinely broken and the build must say so. The
 * degradation this catch was written for is macOS, which has no backend at all.
 *
 * ⚠️ The old message also overstated the damage and would have sent a reader the wrong way: the
 * desktop sidecar is an Electron `utilityProcess`, i.e. NODE, and `host.node.ts` watches with
 * `fs.watch`, loading no library. What a missing `host.dll` costs is the BUN side — the compiled
 * `novaclaw` CLI, where `watcher.ts` answers a failed load with an empty service.
 */
await $`bun ../host/build.ts`.catch((error) => {
  const detail = String(error?.stderr?.toString().trim() || error)
  if (process.platform === "win32") {
    console.error(`the host module FAILED to build — refusing to package a Windows build without it.`)
    console.error(detail)
    process.exit(1)
  }
  console.warn(`WARNING: could not build the host module — the Bun runtime will have no file watcher here.`)
  console.warn(detail)
})
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

/**
 * The DHT sidecar, for the same reason and with the same rules as the host module above: built here
 * because `electron-builder.config.ts` copies `packages/dht/build/` into `resources/dht/`, and that
 * directory has to EXIST before packaging.
 *
 * 🔴 It was never built and never copied, so **the desktop app — the product's primary face —
 * shipped without a DHT at all** while the CLI build had carried one since the sidecar was written
 * (review 1.7). Discovery fell back to the LAN and typed addresses for every desktop user, which
 * looks exactly like a public DHT with nobody in it.
 *
 * ⚠️ Not fatal, exactly like the host module: most machines have no cargo toolchain, and an
 * instance without the sidecar is a documented degradation. The build says so on stdout.
 */
await $`bun ../dht/build.ts`.catch((error) => {
  console.warn(`WARNING: could not build the DHT sidecar — this package will discover by LAN and typed addresses only.`)
  console.warn(error?.stderr?.toString().trim() || error)
})

await $`cd ../novaclaw && bun script/build-node.ts`
