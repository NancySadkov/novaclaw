#!/usr/bin/env bun
import { $ } from "bun"

import { enforce } from "../../../script/lib/heavy-guard"
import { MINIMUM_FREE_BYTES } from "./build-memory"
import { sweepStrayServers } from "../../../script/lib/stray-servers"
import { resolveChannel } from "./utils"
import { prepareW64devkit } from "./prepare-w64devkit"
import { prepareImageMagick } from "./prepare-imagemagick"
import { prepareRipgrep } from "./prepare-ripgrep"
import { dhtBuildArguments } from "./dht-packaging"

// The guard has to bite from BOTH sides. prebuild is the first lifecycle step of every desktop build,
// so refusing here stops a build from piling onto a suite already running. The floor is DERIVED from
// the measured peak in `build-memory.ts` rather than typed here, so the number and the measurement
// that justifies it cannot drift apart. The independent commit-charge ceiling still catches broader
// system pressure.
enforce("a desktop build", process.argv, { minimumFreeBytes: MINIMUM_FREE_BYTES })

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
await prepareRipgrep()
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
 * 🔴 Missing is tolerated only for the explicit development channel. A beta/prod package without
 * public discovery is an incomplete product, so `build.ts` is strict there and this call is not
 * wrapped in a catch. The builder itself verifies the resulting staged executable again.
 */
await $`bun ../dht/build.ts ${dhtBuildArguments(channel)}`

/**
 * The watchdog (`packages/watchdog`), on the same terms as the two above: built here because
 * `electron-builder.config.ts` copies `packages/watchdog/build/` into `resources/watchdog/`, and that
 * directory has to EXIST before packaging.
 *
 * ⚠️ Not fatal, for the same reason — most machines have no cargo toolchain, and an instance without
 * it still restarts a crashed sidecar through the in-process supervisor. What is lost is only the
 * outermost layer: surviving the death of the supervisor itself.
 *
 * 🔴 This one degrades more quietly than the others. A missing DHT is visible the first time nobody
 * is discovered; a missing watchdog is invisible until something crashes, which is exactly when
 * nobody is looking. `build.ts` says so on stdout for that reason.
 */
await $`bun ../watchdog/build.ts`.catch((error) => {
  console.warn(`WARNING: could not build the watchdog — a crashed instance will not be restarted automatically.`)
  console.warn(error?.stderr?.toString().trim() || error)
})

await $`cd ../novaclaw && bun script/build-node.ts`
