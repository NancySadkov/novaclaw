#!/usr/bin/env bun
import { spawnSync } from "node:child_process"

import { heavyJobLabels } from "./heavy-guard"

/**
 * Sweep the long-lived dev/serve backends this repo leaves behind.
 *
 * 🔴 **Owner, 2026-08-28**, after a release build refused to package because `host.dll` could not be
 * linked — *"please ensure that bun startup is guarded, so unless explicitly overridden, launching
 * new bun or launching build kills existing buns. That way we should also get protected from OOM
 * issues."* Four `bun` servers from earlier in that session were still alive; one held the DLL open,
 * and `Permission denied` is what a build sees when it tries to relink it.
 *
 * ⚠️ **This is deliberately NOT the heavy guard, and must never grow into it.** `heavy-guard.ts`
 * covers builds, suites, typechecks and the local model — and it REFUSES rather than kills, for a
 * reason paid for once already: on 2026-08-14 a pid it named was read as a stray and killed with
 * `/T`, and it was a CONCURRENT CLAUDE SESSION'S GATE RUN, taking its shards and migration check with
 * it. A test run is expensive and someone may be watching it. An idle `serve` is neither.
 *
 * So the two are kept disjoint BY CONSTRUCTION: anything `heavyJobLabels` recognises is excluded
 * here, and `stray-servers.test.ts` asserts that for every heavy pattern. The gap this fills is
 * exactly the set the heavy guard does not name — idle servers, which cost memory and hold file
 * locks and are free to restart.
 */

/** Escape hatch: set to keep a server you are deliberately running across a build. */
export const KEEP_ENV = "NOVACLAW_KEEP_SERVERS"

/**
 * The shapes a NovaClaw dev backend takes on this machine.
 *
 * ⚠️ Matched by SHAPE, not by repo path, and that is forced rather than chosen: the parent's command
 * line is `bun.exe run --cwd packages/novaclaw --conditions=browser src/index.ts serve --port N` —
 * every path in it is RELATIVE, so there is nothing absolute to scope against. Only the re-exec'd
 * child carries the checkout's full path. The consequence is stated rather than hidden: a second
 * checkout's dev server on the same box matches too. That is the behaviour the owner asked for
 * ("launching new bun … kills existing buns"), and every kill is printed with its command line so a
 * surprise is legible instead of mysterious.
 */
const SERVER_PATTERNS: Array<{ label: string; match: RegExp }> = [
  /**
   * The server's ENTRY FILE, which is what makes it a server.
   *
   * ⚠️ It was `--cwd packages/novaclaw` on its own for one draft, and that is a kill waiting to
   * happen: `bun run --cwd packages/novaclaw script/build.ts` and `… test` match it too, and neither
   * is spelled the way `heavyJobLabels` recognises — so the CLI build would have been swept as an
   * idle server. Requiring `src/index.ts` is what separates "running the server" from "running
   * something else from the server's directory".
   */
  {
    label: "a NovaClaw serve backend",
    match: /packages[\\/]novaclaw[\\/]src[\\/]index\.ts|--cwd\s+packages[\\/]novaclaw\b[^\n]*\bsrc[\\/]index\.ts/i,
  },
  // The `--no-supervise` child `serve` re-execs, which is the one that outlives a port-based kill.
  { label: "a NovaClaw serve child", match: /--no-supervise/i },
  // The web preview (`bun --cwd packages/app dev`) and the vite process under it.
  { label: "the app's vite dev server", match: /--cwd\s+packages[\\/]app\s+dev|[\\/]vite[\\/]bin[\\/]vite\.js/i },
]

/** Only these can BE a stray server — mirrors the heavy guard's reason for checking the executable. */
const SERVER_EXECUTABLES = /^(bun|node)\.exe$/i

/**
 * What this process is, if it is a sweepable server. Pure, and exported, so the one rule that decides
 * whether something gets killed can be held still by a test instead of being read off a regex.
 */
export function strayServerLabel(name: string, commandLine: string): string | undefined {
  if (!SERVER_EXECUTABLES.test(name.trim())) return undefined
  // The probe must never match itself — the same false positive the heavy guard hit with `tsgo`.
  if (/stray-servers|heavy-guard|Get-CimInstance|Win32_Process/i.test(commandLine)) return undefined
  /**
   * 🔴 The disjointness rule, enforced HERE rather than trusted to the patterns above. A heavy job is
   * somebody's build or suite; killing one is the documented disaster this file exists not to repeat.
   * A pattern that ever widened into `script/test.ts` would otherwise do it silently.
   */
  if (heavyJobLabels(name, commandLine).length > 0) return undefined
  return SERVER_PATTERNS.find((entry) => entry.match.test(commandLine))?.label
}

export type StrayServer = { readonly pid: number; readonly label: string; readonly commandLine: string }

/** Every sweepable server running now, excluding this process and its parent. */
export function findStrayServers(): StrayServer[] {
  if (process.platform !== "win32") return []
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | " +
    'ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }'
  const proc = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (proc.status !== 0 || !proc.stdout) return []
  const found: StrayServer[] = []
  for (const line of proc.stdout.split(/\r?\n/)) {
    const [pidText, name, ...rest] = line.split("\t")
    if (pidText === undefined || name === undefined || rest.length === 0) continue
    const pid = Number(pidText.trim())
    const commandLine = rest.join("\t")
    // Same exclusions as the heavy guard, for the same reason: never the caller, never its parent.
    if (!Number.isFinite(pid) || pid === process.pid || pid === process.ppid) continue
    const label = strayServerLabel(name, commandLine)
    if (label) found.push({ pid, label, commandLine })
  }
  return found
}

/**
 * Kill one process through the API that can still SEE it.
 *
 * ⚠️ `Invoke-CimMethod Terminate`, not `taskkill` or `Stop-Process`. Measured 2026-08-05 on a wedged
 * bun: `taskkill //T //F` returned 255 *"no running instance"* while `Win32_Process` still listed the
 * entry with its commit intact; `Terminate` returned 0 and the row went away. The shell tools lie
 * about existence, and a sweep that believes them reports success over a process that is still there.
 */
function terminate(pid: number): boolean {
  const proc = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Invoke-CimMethod -MethodName Terminate).ReturnValue`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  )
  // A process that exited on its own between the scan and now is a success, not a failure.
  return proc.status === 0 && /^0\s*$/m.test(proc.stdout ?? "")
}

export type SweepResult = { readonly killed: StrayServer[]; readonly failed: StrayServer[]; readonly skipped: boolean }

/**
 * Sweep, and say what happened.
 *
 * ⚠️ It does NOT free a port, and must not be sold as doing so. A `serve` child that inherited the
 * listening socket keeps `:4096` in LISTENING after every process API reports it gone (measured
 * 2026-08-23; `netstat -ano` is the only thing that still names the owner). What this reliably buys
 * is the memory back and the FILE LOCKS released — which is the failure that prompted it.
 */
export function sweepStrayServers(input: {
  readonly reason: string
  readonly log?: (line: string) => void
}): SweepResult {
  const log = input.log ?? ((line: string) => console.log(line))
  if (process.env[KEEP_ENV]) {
    log(`servers: keeping any running backends (${KEEP_ENV} is set)`)
    return { killed: [], failed: [], skipped: true }
  }
  const strays = findStrayServers()
  if (strays.length === 0) return { killed: [], failed: [], skipped: false }
  log(`servers: ${strays.length} idle backend(s) found before ${input.reason} — sweeping.`)
  const killed: StrayServer[] = []
  const failed: StrayServer[] = []
  for (const stray of strays) {
    // Printed with the COMMAND LINE, not just a pid: a kill the reader cannot identify is the same
    // as an unexplained one, and this is the file that has to be trusted not to hit the wrong thing.
    if (terminate(stray.pid)) {
      killed.push(stray)
      log(`  killed ${stray.pid}  ${stray.label}  ${stray.commandLine.slice(0, 120)}`)
    } else {
      failed.push(stray)
      log(`  COULD NOT KILL ${stray.pid}  ${stray.label} — it may hold a file lock or a port`)
    }
  }
  if (failed.length)
    log(`servers: ${failed.length} survived the sweep; a build that needs their files will still fail.`)
  return { killed, failed, skipped: false }
}

if (import.meta.main) {
  sweepStrayServers({ reason: process.argv[2] ?? "starting a dev server" })
  // Never fails the caller: a sweep is hygiene, and a machine with nothing to sweep is the good case.
  // A survivor is REPORTED, not fatal — the build that needs its files will fail on its own terms,
  // with the linker's message, which is more use than this script guessing.
  process.exit(0)
}
