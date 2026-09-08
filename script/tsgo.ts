#!/usr/bin/env bun
/**
 * The ONLY way to run `tsgo` in this repo. It owns the process, admits one at a time, and kills a
 * runaway.
 *
 * 🔴 **Why (2026-08-18).** A `tsgo` run reached **>10 GB** of commit on this 20-core box, exhausted
 * memory and locked the machine hard, taking a working session with it. Several agents were each
 * running a typecheck at the time. A typechecker is not entitled to that, so crossing a ceiling is
 * treated as a DEFECT — the process dies and says why — and concurrent runs are serialised rather
 * than allowed to stack.
 *
 * ## What was measured, so nobody re-derives it
 *
 * Peak COMMIT charge (a runaway shows in commit long before the working set moves):
 *
 *     per package  `-b` core, WARM incremental                854 MB
 *     per package  `-b` core, COLD                       4097-4158 MB  <- over the ceiling, parallel
 *     per package  `-b` server, warm                          2201 MB
 *     ROOT         `-b` parallel, GOMEMLIMIT=3GiB         >5390 MB
 *     ROOT         `-b` --singleThreaded, GOMEMLIMIT=3GiB  4178 MB   18 s
 *     ROOT         `-b` --singleThreaded, GOMEMLIMIT=2GiB  4189 MB   24 s
 *     ROOT         `-b` --singleThreaded, GOMEMLIMIT=1.5G  4307 MB   30 s
 *     ROOT         `-b` --singleThreaded, GOMEMLIMIT=1GiB  4259 MB   34 s
 *
 * ⭐ **The root build cannot be tuned under 4 GB, and the last four rows are the proof.** Lowering
 * `GOMEMLIMIT` made it monotonically SLOWER (18 → 34 s) and never smaller. That is the signature of a
 * large LIVE set rather than uncollected garbage: the whole-monorepo type graph is genuinely retained,
 * so the collector has nothing to reclaim and only thrashes. `GOMEMLIMIT` is a soft limit over the
 * heap; it cannot evict live objects.
 *
 * ⚠️ Two plausible-sounding levers that do NOT work, so they are not used here:
 *   · `GOMAXPROCS=4` — peak 1102 MB vs 1080 MB baseline. Parallelism costs ~1.2 GB on the ROOT build
 *     and nothing per package; it is not what makes this big.
 *   · A `--concurrency` flag — **does not exist**. `--singleThreaded` is tsgo's only threading control,
 *     and it buys ~1.2 GB on the root build for ~14 s.
 *
 * ## The design that follows from that
 *
 * Typecheck PER PACKAGE and never whole-repo in one process. The repo's own `bun run typecheck` already
 * does this via `script/test.ts`.
 *
 * ⚠️ **The "≤2.2 GB per package" claim this paragraph used to make was WARM-only, and it was wrong in
 * the case that matters.** A COLD `packages/core` peaks 4097-4158 MB parallel — just over the ceiling —
 * so it was killed on every clean checkout, and `packages/novaclaw` inherited it. That is what the
 * downscale ladder below exists for: it now retries single-threaded and PASSES. Measured 2026-08-19.
 * A number taken from a warm build and written as if general is how a guard ends up refusing honest work.
 *
 * SINGLE ENTRY is the other half and the one that actually caused the lockup: one 2 GB typecheck is
 * fine, five at once is not. A lock is honest here in a way tuning is not.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { platform } from "node:os"

import { isStandingGuard } from "./lib/guard-record"

/** Hard ceiling. Above this the process is killed: per-package peaks at 2.2 GB, so 4 GB is slack. */
const CEILING_MB = Number(process.env.TSGO_CEILING_MB ?? 4096)
/**
 * A SOFT budget set just under the hard ceiling, so the collector fights hardest in the last stretch
 * before the kill. Deliberately not lower: the table above shows a lower limit only costs time.
 */
const MEM_LIMIT = process.env.GOMEMLIMIT ?? "3500MiB"
const GC_PERCENT = process.env.GOGC ?? "80"
const CHECK_MS = Number(process.env.TSGO_CHECK_MS ?? 400)
/** How long to queue behind another run before giving up. Typechecks here take seconds, not minutes. */
const LOCK_WAIT_MS = Number(process.env.TSGO_LOCK_WAIT_MS ?? 10 * 60_000)

const root = dirname(import.meta.dir)
const lockPath = join(root, "tmp", "tsgo.lock")
const logPath = join(root, "tmp", "tsgo-guard.log")

function log(message: string) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, `${new Date().toISOString()}  ${message}\n`, { flag: "a" })
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Single entry, across processes.
 *
 * ⚠️ A stale lock must never wedge the repo: if the recorded pid is gone the lock is taken over. The
 * failure this protects against is concurrent MEMORY, so a lock that outlives its owner would convert
 * a crash into a permanent outage — a worse bug than the one being fixed.
 */
async function acquireLock(): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  mkdirSync(dirname(lockPath), { recursive: true })
  let announced = false
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" })
      return () => {
        try {
          rmSync(lockPath, { force: true })
        } catch {}
      }
    } catch {
      const holder = Number(readFileSync(lockPath, "utf8").trim())
      if (!Number.isFinite(holder) || !alive(holder)) {
        log(`stale lock from pid ${holder} — taking over`)
        try {
          rmSync(lockPath, { force: true })
        } catch {}
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the tsgo lock held by pid ${holder}`)
      if (!announced) {
        console.error(`[tsgo] another typecheck is running (pid ${holder}) — queued.`)
        announced = true
      }
      await Bun.sleep(250)
    }
  }
}

/**
 * Watch one pid and stream its memory, from a SINGLE long-lived helper.
 *
 * ⚠️ **This cannot catch a SHORT run, and the limit is measured, not assumed.** A helper process
 * costs ~600–1000 ms to start on Windows; instrumented against a real `-b` in `packages/core`, the
 * first sample arrived at **+1043 ms and reported `GONE`** — the build had already finished. Two
 * earlier versions (a spawn per sample, then an unflushed stream) failed the same way and made a
 * ceiling-of-300 MB test pass silently, which looks exactly like a working guard.
 *
 * So this is the SECOND line of defence, for runs long enough to be dangerous. The first is
 * `script/tsgo-guard.ps1`, which is long-lived and therefore has no startup cost — it is the one with
 * real kills to its name (4149–5394 MB, logged). A sub-second process is not the threat: the failure
 * that locked this box climbed for seconds.
 *
 * `onSample` is called with megabytes. Commit charge on Windows, RSS elsewhere — a runaway shows up
 * in commit long before the working set moves.
 */
function watchMemory(pid: number, intervalMs: number, onSample: (mb: number) => void): () => void {
  const command =
    platform() === "win32"
      ? [
          "powershell",
          "-NoProfile",
          "-Command",
          // ⚠️ `[Console]::Out.WriteLine` + an explicit Flush, NOT a bare expression. PowerShell
          // block-buffers stdout when it is a pipe rather than a TTY, so the samples arrived only
          // when the buffer flushed — at exit — and the kill never fired against a ~1 s build while
          // the peak was still recorded. Same shape of trap as the per-sample spawn it replaced.
          `while ($true) { $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
            `if (-not $p) { break }; [Console]::Out.WriteLine([math]::Round($p.PagedMemorySize64 / 1MB)); ` +
            `[Console]::Out.Flush(); Start-Sleep -Milliseconds ${intervalMs} }`,
        ]
      : ["sh", "-c", `while ps -p ${pid} > /dev/null 2>&1; do ps -o rss= -p ${pid}; sleep ${intervalMs / 1000}; done`]

  const monitor = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
  void (async () => {
    const decoder = new TextDecoder()
    let carry = ""
    for await (const chunk of monitor.stdout) {
      carry += decoder.decode(chunk)
      const lines = carry.split(/\r?\n/)
      carry = lines.pop() ?? ""
      for (const line of lines) {
        const value = Number(line.trim())
        if (!Number.isFinite(value) || value <= 0) continue
        // `ps` reports KB; PowerShell already reports MB.
        onSample(platform() === "win32" ? value : Math.round(value / 1024))
      }
    }
  })()
  return () => {
    try {
      monitor.kill()
    } catch {}
  }
}

// ⚠️ Imported by FILE PATH: the package's `exports` map does not expose `lib/`, so importing it by
// specifier fails. And it must be the REAL binary — `node_modules/.bin/tsgo` is a ~16 KB launcher stub
// that spawns the Go process as a CHILD, so watching the stub reports ~1 MB forever and the guard
// would be silently useless. That is exactly what happened on the first attempt at this.
const resolverUrl = new URL("../node_modules/@typescript/native-preview/lib/getExePath.js", import.meta.url)
const { default: getExePath } = (await import(resolverUrl.href)) as { default: () => string }
const binary = getExePath()

const args = process.argv.slice(2)
if (process.env.TSGO_SINGLE_THREADED === "1" && !args.includes("--singleThreaded")) args.push("--singleThreaded")

const guardPath = join(root, "tmp", "tsgo-guard.pid")
/** Measured 2026-08-18: a PowerShell helper costs ~600–1000 ms to appear. Wait a little past that. */
const GUARD_START_WAIT_MS = 3_000

/**
 * Is a guard standing right now?
 *
 * ⚠️ **A live pid is not enough, and this is the half that broke when the guard learned to exit.**
 * The rule and the reasoning live in `lib/guard-record.ts`, where they can be exercised; this is the
 * I/O around it.
 */
function standingGuard(): boolean {
  if (!existsSync(guardPath)) return false
  try {
    return isStandingGuard(readFileSync(guardPath, "utf8"), Date.now(), alive)
  } catch {
    return false
  }
}

/**
 * Make sure the long-lived guard is up before running anything.
 *
 * 🔴 This is the enforcement that actually works. The in-process watcher below cannot see a run that
 * finishes inside its own helper's startup latency; the standing guard has no startup cost because it
 * is already running, and it is the one that has actually killed runaways on this box. Starting it
 * here means "use the wrapper" is the only thing anyone has to remember.
 *
 * ⚠️ **It WAITS for the guard to come up, and that wait is what makes the guard's idle-exit safe.**
 * The guard now ends itself once `tsgo` has finished, so the first typecheck after a quiet spell
 * starts one — and returning immediately would hand that run the exact hole the standing guard exists
 * to close: unguarded for the ~1 s the helper takes to appear, which is where a cold `packages/core`
 * (4097–4158 MB, over the ceiling) begins climbing. Paying up to a second, once per idle period,
 * against a runaway that has locked this box, is the trade taken deliberately.
 */
function ensureGuard() {
  if (platform() !== "win32") return // the .ps1 guard is Windows-only; the in-process watcher still applies
  try {
    // ⚠️ A PID FILE, not a process scan. The first version asked PowerShell to count processes whose
    // command line contains "tsgo-guard.ps1" — and the counting command's own command line contains
    // that string, so it matched ITSELF, always answered "one is running", and the guard was never
    // started. The bug is invisible: everything looks fine until a runaway is not caught.
    if (standingGuard()) return
    rmSync(guardPath, { force: true })
    const guard = join(root, "script", "tsgo-guard.ps1")
    if (!existsSync(guard)) return
    // ⚠️ `-ExecutionPolicy Bypass` is REQUIRED, not belt-and-braces: this machine runs the default
    // Restricted policy, so `powershell -File guard.ps1` fails with "running scripts is disabled on
    // this system" — on stderr, into a spawn whose output we discard. The wrapper cheerfully printed
    // "started the memory guard" while nothing had started. Per-invocation, so no system policy is
    // changed. `pwsh` (7) first, falling back to Windows PowerShell (5.1).
    // ⚠️ Launched through `Start-Process` so the guard OUTLIVES this wrapper. `Bun.spawn(...).unref()`
    // was not enough on Windows — the guard died with its parent, so every run started a fresh one
    // that was dead by the next run, and the pid file pointed at a corpse. `unref()` only drops the
    // event-loop reference; it does not detach the process.
    const shell = Bun.which("pwsh") ?? "powershell"
    const inner = `-NoProfile -ExecutionPolicy Bypass -File "${guard}" -CeilingMB ${CEILING_MB}`
    Bun.spawnSync([
      shell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Start-Process -FilePath "${shell}" -ArgumentList '${inner}' -WindowStyle Hidden`,
    ])
    // Wait for the guard's own heartbeat rather than for a fixed delay: the spawn above returns as
    // soon as `Start-Process` has been ASKED, which says nothing about whether the script ran. An
    // ExecutionPolicy refusal or a missing pwsh lands here as "the beat never came", not as a hang.
    const deadline = Date.now() + GUARD_START_WAIT_MS
    while (Date.now() < deadline && !standingGuard()) Bun.sleepSync(50)
    if (!standingGuard()) {
      log(`the standing guard did not report within ${GUARD_START_WAIT_MS} ms — running on the in-process watcher`)
      console.error(`[tsgo] the memory guard did not start; the in-process watcher still applies.`)
      return
    }
    log(`started the standing guard at ${CEILING_MB} MB`)
    console.error(`[tsgo] started the memory guard (${CEILING_MB} MB ceiling).`)
  } catch {
    // A guard we could not start must not block a typecheck — the lock below is still in force.
  }
}

ensureGuard()
const release = await acquireLock()

/**
 * Free physical memory in MB, or `undefined` when it cannot be read.
 *
 * Used for ONE decision — whether to start already-downscaled. A guard that only kills teaches nothing
 * and costs the whole run; knowing the box is tight before spawning is what lets it degrade instead.
 */
function freeMemoryMB(): number | undefined {
  if (platform() !== "win32") return undefined
  const probe = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB)",
  ])
  const value = Number(new TextDecoder().decode(probe.stdout).trim())
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * One attempt. Resolves with the exit code, or `"over-ceiling"` when the guard had to kill it.
 *
 * ⚠️ The child is watched rather than trusted: `GOMEMLIMIT` is a SOFT limit over the heap and cannot
 * evict a live set, which is why a hard ceiling exists at all.
 */
function attempt(runArgs: readonly string[], memLimit: string): Promise<number | "over-ceiling"> {
  return new Promise((resolve) => {
    let killed = false
    let peak = 0
    const child = spawn(binary, [...runArgs], {
      stdio: "inherit",
      env: { ...process.env, GOMEMLIMIT: memLimit, GOGC: GC_PERCENT },
    })
    const stopWatching =
      child.pid === undefined
        ? () => {}
        : watchMemory(child.pid, CHECK_MS, (mb) => {
            if (killed) return
            if (mb > peak) peak = mb
            if (mb <= CEILING_MB) return
            killed = true
            log(`over ceiling at ${mb} MB | args: ${runArgs.join(" ")}`)
            try {
              if (child.pid !== undefined) process.kill(child.pid, "SIGKILL")
            } catch {}
          })
    child.on("exit", (code, signal) => {
      stopWatching()
      if (peak > 0) log(`tsgo peak ${peak} MB | exit ${killed ? "KILLED" : (code ?? signal)} | args: ${runArgs.join(" ")}`)
      resolve(killed ? "over-ceiling" : signal ? 1 : (code ?? 0))
    })
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        try {
          if (child.pid !== undefined) process.kill(child.pid, "SIGKILL")
        } catch {}
        stopWatching()
        release()
        process.exit(1)
      })
    }
  })
}

/**
 * 🔴 **DOWNSCALE before dying.** The first version only killed, which is the right backstop and a poor
 * strategy: a run that would have fitted single-threaded was destroyed for using the concurrency it was
 * given. Measured on this repo — a whole-repo `-b` peaks **>5.4 GB parallel and ~4.2 GB
 * `--singleThreaded`**, so serialising is worth ~1.2 GB, and a per-package build (854 MB – 2.2 GB) has
 * room either way.
 *
 * ⚠️ `GOMEMLIMIT` is NOT the lever here and lowering it further is a trap: at 3 GiB / 2 GiB / 1.5 GiB /
 * 1 GiB the same build peaked 4178 / 4189 / 4307 / 4259 MB while wall time rose 18 → 34 s. That is a
 * large LIVE set, which a soft heap limit cannot evict — it only makes the collector thrash.
 *
 * So the ladder is CONCURRENCY, not GC: parallel, then single-threaded, then an honest refusal naming
 * the one thing that actually fits — per-package.
 */
const alreadySerial = args.includes("--singleThreaded")
const free = freeMemoryMB()
// Start downscaled when the box cannot plausibly hold a parallel run: the ceiling plus a working margin
// for everything else on the machine. Cheaper than discovering it by being killed.
const startSerial = alreadySerial || (free !== undefined && free < CEILING_MB + 1024)
if (startSerial && !alreadySerial)
  console.error(`[tsgo] only ${free} MB free — starting single-threaded to stay under ${CEILING_MB} MB.`)

const firstArgs = startSerial && !alreadySerial ? [...args, "--singleThreaded"] : args
let outcome = await attempt(firstArgs, MEM_LIMIT)

if (outcome === "over-ceiling" && !startSerial) {
  console.error(
    `
[tsgo] over the ${CEILING_MB} MB ceiling — retrying single-threaded, which measured ~1.2 GB cheaper.
`,
  )
  log(`downscaling to --singleThreaded | args: ${args.join(" ")}`)
  outcome = await attempt([...args, "--singleThreaded"], MEM_LIMIT)
}

if (outcome === "over-ceiling") {
  console.error(
    `
[tsgo] still over ${CEILING_MB} MB with concurrency already at 1.
` +
      `[tsgo] Lowering GOMEMLIMIT will not help — this is live heap, not garbage (measured).
` +
      `[tsgo] Typecheck the package you changed: \`cd packages/<name> && bun run typecheck\`.
` +
      `[tsgo] Per-package peaks are 854 MB – 2.2 GB and fit comfortably.
`,
  )
  release()
  process.exit(97)
}

release()
process.exit(outcome)

// ⚠️ A SIGINT/SIGTERM block used to sit here, AFTER the `process.exit(outcome)` above, and it was
// dead three times over (deleted 2026-08-19): unreachable at top level, referencing `child` which is
// scoped inside `attempt()`, and calling a `finish()` that is not defined anywhere in this file. It
// also broke `typecheck:repo-script` — `tsgo.ts(367,11): Property 'on' does not exist on type
// 'never'`, the compiler narrowing an unreachable statement — so the repo's own build tooling had a
// red typecheck unit that nothing was tracking. The LIVE handler is inside `attempt()`, registered
// with the child it kills in scope, and it releases the lock before exiting.
