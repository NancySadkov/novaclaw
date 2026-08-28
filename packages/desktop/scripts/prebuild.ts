#!/usr/bin/env bun
import { $ } from "bun"

import { enforce } from "../../../script/lib/heavy-guard"
import { sweepStrayServers } from "../../../script/lib/stray-servers"
import { resolveChannel } from "./utils"
import { prepareW64devkit } from "./prepare-w64devkit"
import { prepareImageMagick } from "./prepare-imagemagick"

// The guard has to bite from BOTH sides. prebuild is the first lifecycle step of every desktop build,
// so refusing here stops a build from piling onto a suite already running. The desktop floor is
// measured rather than inherited from the much larger test suite: on a 16 GB Windows machine the
// production Vite stage completes under a 1.25 GB V8 old-space cap and electron-builder stayed below
// 1 GB, sequentially. The 2.5 GB admission floor therefore protects the host without excluding the
// laptops we ship for; the independent commit-charge ceiling still catches broader system pressure.
enforce("a desktop build", process.argv, { minimumFreeBytes: 2.5 * 1024 ** 3 })

/**
 * 🔴 **Idle backends are swept before the build touches a file** (owner, 2026-08-28: *"please ensure
 * that bun startup is guarded, so unless explicitly overridden, launching new bun or launching build
 * kills existing buns"*). The 0.1.67 build refused to package minutes earlier: four `bun` servers
 * left over from a session still held `packages/host/build/host.dll` open, and the linker reported
 * `Permission denied`.
 *
 * ⚠️ AFTER `enforce`, never before. The heavy guard REFUSES when somebody else's build or suite is
 * running, and that refusal is what protects a concurrent session — a sweep that ran first would be
 * deciding the same question with a kill instead of a wait. This only removes what the heavy guard
 * deliberately does not name: idle servers, which are free to restart.
 */
sweepStrayServers({ reason: "a desktop build" })

const channel = resolveChannel()
await prepareW64devkit()
// ⚠️ NOT wrapped in a soft catch, and that is deliberate — the same lesson `prepareW64devkit` above
// carries. A tolerated failure here ships a build whose agents believe they can edit images and
// cannot, and the word WARNING scrolls past in a 4,000-line log. It is idempotent and cheap after
// the first run (SHA-256 marker, cached archive), so failing loudly costs a rebuild, not a day.
await prepareImageMagick()

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
