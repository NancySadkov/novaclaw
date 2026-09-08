import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { Global } from "@novaclaw/core/global"
import { Repository } from "@novaclaw/core/repository"
import { RepositoryCache } from "@novaclaw/core/repository-cache"
import { git, withRemote } from "./fixture/git"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

/**
 * **Why these tests carry an explicit budget instead of the suite's 15 s, and where 60 s comes from.**
 *
 * Two of them (`serializes …`, `replaces an existing checkout …`) timed out at 15 s under a full gate
 * three times on 2026-08-07 and passed 4/4 in isolation each time — ``. That part
 * says the question to answer FIRST is whether their work is concurrent with the rest of the unit. It
 * is not, and the whole reason for this comment is that the answer is *machine load*, not a race:
 *
 * - `script/test.ts` runs every run unit — and every shard — SEQUENTIALLY (`for (const pkg of
 *   PACKAGES)` around a `spawnSync`). Nothing else in the gate is executing while `core` runs.
 * - Nothing here is shared with another `core` test. Every path is a per-test `mkdtemp` under a
 *   PID-named root (`test/fixture/tmpdir.ts`), and `Global.layerWith` puts the repo root *and*
 *   `EffectFlock`'s lock root (`<state>/locks`) inside it. The one process-global thing is the git
 *   TEMPLATE, which is write-once and thereafter only ever the source of an `fs.cp`.
 * - What they actually contend on is machine-wide and outside this repo's reach: **Windows process
 *   creation**. Each `ensure()` is a fistful of real `git.exe` spawns (pinned below), and a spawn on
 *   this box costs ~120 ms idle and ~900 ms when the box is busy.
 *
 * Measured here (bun's junit reporter, per test, seconds):
 *
 * | test | warm+idle | warm + 16 concurrent bun test processes |
 * | --- | --- | --- |
 * | replaces a stale cache directory | 1.88 | **13.56** |
 * | serializes concurrent materialization | 1.45 | 5.13 |
 * | replaces an existing checkout whose origin | 1.82 | 10.29 |
 * | returns typed validation and clone failures | 0.39 | 1.61 |
 *
 * So the old budget's margin was **1.1×** on a merely-busy box, and the gate — where `core` peaks
 * near 8 GB and the host file cache is squeezed — pushed it past. (Cold matters as much as busy: the
 * first run of the day cost 17.6 s for the four together against 6.3 s warm.)
 *
 * **60 s is derived from the backstop, not rounded up from a failure.** `core`'s wall-clock kill is
 * 600 s, and a kill produces no parseable failure list while a per-test timeout names the test. Four
 * raised budgets (three here + `npm.test.ts`) wedging at once is 240 s — still well inside 600 s, so a
 * genuine hang still fails *diagnosably*. That leaves 4.4× headroom over the worst honest number
 * measured above, where 15 s left 1.1×.
 *
 * 🔴 **The clock is no longer the regression detector — `GIT_SPAWNS` below is.** Raising a timeout is
 * how a real race gets papered over, so the load-INDEPENDENT quantity is pinned instead: the number of
 * child processes each scenario spawns. A lock that stopped serializing, or a `refreshed` path that
 * started fetching twice, moves that count on any machine at any load.
 */
const BUDGET_MS = 60_000

/**
 * Shrink-only pins on the child processes `RepositoryCache` spawns per scenario — `<=`, so an
 * optimisation lands free and a regression cannot.
 *
 * ⚠️ Only the CACHE's spawns are counted, never the fixture's: the recorder is installed on the node
 * graph `cacheLayer` builds, and `fixture/git.ts` shells out through `child_process.execFile`
 * directly. That is what makes these numbers order-independent — the fixture's first call in a process
 * builds the template and costs ~14 spawns, every later one costs 1.
 */
const GIT_SPAWNS = {
  /** clone · rev-parse(×2, discover) · rev-parse HEAD · symbolic-ref */
  stale: 5,
  /** the winner's 5 above, plus the loser's cached path: discover · remote get-url · branch ×2 · HEAD */
  concurrent: 11,
  /** a first `ensure()` at 5, then discover · remote get-url · re-clone at 7 */
  originMismatch: 12,
  /** the two validation failures spawn nothing at all; only the doomed clone does */
  failures: 1,
} as const

// Git is SCENERY here: the subject is the cache's own decisions — replace a stale directory, serialize
// two concurrent materializations, replace a checkout whose origin drifted, and surface typed failures.
// The clone each `ensure()` performs is real and stays real; only the remote it clones FROM comes from
// a template built once per process and copied (test/fixture/git.ts).
describe("RepositoryCache", () => {
  it.live(
    "replaces a stale cache directory before cloning",
    () =>
      withRemote((fixture) => {
        const spawns: string[] = []
        return Effect.gen(function* () {
          const localPath = Repository.cachePath(path.join(fixture.root, "repos"), fixture.reference)
          yield* Effect.promise(async () => {
            await fs.mkdir(localPath, { recursive: true })
            await fs.writeFile(path.join(localPath, "stale.txt"), "stale")
          })

          const result = yield* (yield* RepositoryCache.Service).ensure({ reference: fixture.reference })

          expect(result.status).toBe("cloned")
          expect(yield* exists(path.join(localPath, "stale.txt"))).toBe(false)
          expect(yield* read(path.join(localPath, "README.md"))).toBe("one\n")
          expectSpawns(spawns, GIT_SPAWNS.stale)
        }).pipe(Effect.provide(cacheLayer(fixture.root, spawns)))
      }),
    BUDGET_MS,
  )

  it.live(
    "serializes concurrent materialization for the same checkout",
    () =>
      withRemote((fixture) => {
        const spawns: string[] = []
        return Effect.gen(function* () {
          const cache = yield* RepositoryCache.Service
          const results = yield* Effect.all(
            [cache.ensure({ reference: fixture.reference }), cache.ensure({ reference: fixture.reference })],
            { concurrency: "unbounded" },
          )

          expect(results.map((result) => result.status).toSorted()).toEqual(["cached", "cloned"])
          expect(results[0].localPath).toBe(results[1].localPath)
          // The lock did its job iff exactly one `clone` was spawned. `status` says the same thing
          // from the cache's own bookkeeping; this says it from the process table, which is the half
          // a bug in the bookkeeping could not fake.
          expect(spawns.filter((command) => command.startsWith("clone "))).toHaveLength(1)
          expectSpawns(spawns, GIT_SPAWNS.concurrent)
        }).pipe(Effect.provide(cacheLayer(fixture.root, spawns)))
      }),
    BUDGET_MS,
  )

  it.live(
    "replaces an existing checkout whose origin does not match",
    () =>
      withRemote((fixture) => {
        const spawns: string[] = []
        return Effect.gen(function* () {
          const cache = yield* RepositoryCache.Service
          const initial = yield* cache.ensure({ reference: fixture.reference })
          yield* Effect.promise(async () => {
            await git(initial.localPath, "config", "remote.origin.url", "https://git.example.test/other/repo.git")
            await fs.writeFile(path.join(initial.localPath, "stale.txt"), "stale")
          })

          const replaced = yield* cache.ensure({ reference: fixture.reference })

          expect(replaced.status).toBe("cloned")
          expect(yield* exists(path.join(replaced.localPath, "stale.txt"))).toBe(false)
          expectSpawns(spawns, GIT_SPAWNS.originMismatch)
        }).pipe(Effect.provide(cacheLayer(fixture.root, spawns)))
      }),
    BUDGET_MS,
  )

  it.live("returns typed validation and clone failures", () =>
    withRemote((fixture) => {
      const spawns: string[] = []
      return Effect.gen(function* () {
        const cache = yield* RepositoryCache.Service
        const invalidRepository = yield* Effect.flip(RepositoryCache.parseRemote("not-a-repo"))
        expect(invalidRepository).toBeInstanceOf(RepositoryCache.InvalidRepositoryError)

        const invalidBranch = yield* Effect.flip(cache.ensure({ reference: fixture.reference, branch: "../unsafe" }))
        expect(invalidBranch).toBeInstanceOf(RepositoryCache.InvalidBranchError)

        const cloneFailure = yield* Effect.flip(
          cache.ensure({
            reference: { ...fixture.reference, remote: pathToFileURL(path.join(fixture.root, "missing.git")).href },
          }),
        )
        expect(cloneFailure).toBeInstanceOf(RepositoryCache.CloneFailedError)
        expectSpawns(spawns, GIT_SPAWNS.failures)
      }).pipe(Effect.provide(cacheLayer(fixture.root, spawns)))
    }),
  )
})

/**
 * The ratchet, with the observed command list in the message.
 *
 * ⚠️ Ruling 2 — a count that fails must say WHAT it counted, or the next reader re-derives it by hand.
 */
function expectSpawns(spawns: readonly string[], ceiling: number) {
  if (spawns.length > ceiling)
    throw new Error(
      `RepositoryCache spawned ${spawns.length} child processes, above the shrink-only pin of ${ceiling}.\n` +
        `This pin is what detects a cost regression here, because the wall clock no longer can (see\n` +
        `BUDGET_MS above). Raise it only with the reason, never to make a red go away:\n` +
        spawns.map((command) => `  git ${command}`).join("\n"),
    )
  expect(spawns.length).toBeLessThanOrEqual(ceiling)
}

function cacheLayer(root: string, spawns: string[]) {
  return AppNodeBuilder.build(RepositoryCache.node, [
    [Global.node, Global.layerWith({ state: path.join(root, "state"), repos: path.join(root, "repos") })],
    [CrossSpawnSpawner.node, recordingSpawner(spawns)],
  ])
}

/**
 * `CrossSpawnSpawner` with every `spawn` recorded — the ONE chokepoint every git process in the
 * graph goes through (`Git.layer` → `AppProcess.Service` → `ChildProcessSpawner.spawn`), so nothing
 * can route around it while still running git.
 */
function recordingSpawner(into: string[]) {
  return Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner
      return {
        ...inner,
        spawn: (command: ChildProcess.Command) => {
          into.push(describeCommand(command))
          return inner.spawn(command)
        },
      }
    }),
  ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))
}

/** The ARGUMENTS only — the binary is an absolute path that differs per machine and per install. */
function describeCommand(command: ChildProcess.Command): string {
  return command._tag === "StandardCommand"
    ? command.args.join(" ")
    : `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

function exists(file: string) {
  return Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )
}
