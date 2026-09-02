import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import { Worktree } from "../../src/worktree"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node])))

const exists = (target: string) =>
  Effect.promise(() =>
    fs
      .stat(target)
      .then(() => true)
      .catch(() => false),
  )

/**
 * A throwaway tree in the **OS temp dir** — never inside either repository, never a real folder of
 * the person running this.
 *
 * ⚠️ The subject of this file is a recursive delete, so where the fixtures live is part of the test
 * rather than housekeeping: the pre-fix arm of the negative control DOES delete what it is pointed
 * at, and every assertion below is written to survive that by asserting the tree is still THERE.
 */
const outsideTree = (label: string) =>
  Effect.gen(function* () {
    const dir = path.join(os.tmpdir(), `novaclaw-worktree-outside-${label}-${Math.random().toString(36).slice(2)}`)
    yield* Effect.promise(() => fs.mkdir(path.join(dir, "keep"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "keep", "precious.txt"), "not ours to delete"))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    return dir
  })

/**
 * `<data>/worktree/<origin>` — asked of the PRODUCTION path builder rather than rebuilt here.
 *
 * A local `path.join(Global.Path.data, …)` would be a second spelling of the very root the guard
 * compares against, and a test that carries its own copy of the boundary cannot notice the boundary
 * moving.
 */
const containerRoot = Effect.gen(function* () {
  const svc = yield* Worktree.Service
  const probe = yield* svc.makeWorktreeInfo({ name: "probe" })
  return path.dirname(probe.directory)
})

const expectRefusal = (exit: Exit.Exit<boolean, unknown>, directory: string) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(Worktree.OutsideRootError)
  if (error instanceof Worktree.OutsideRootError) {
    expect(error._tag).toBe("WorktreeOutsideRootError")
    // The caller's own string travels back, so a client can name the path it asked about.
    expect(error.directory).toBe(directory)
  }
}

/**
 * 🔴 `remove` recursively deleted ANY directory the caller named — and answered `true`, i.e.
 * "removed" — whenever git did not recognise it as a worktree of this project. Principle 11 head-on:
 * NovaClaw deletes in the home instance dirs, the OS temp dir and the session's folder, nowhere else.
 *
 * ⚠️ All four cases are asserted deliberately. The three refusals alone would pass against a
 * `remove` that refuses everything — which would break the feature — so the last one is the control,
 * and it exercises the SAME branch with a contained path.
 */
describe("Worktree.remove containment", () => {
  it.instance(
    "🔴 refuses a directory outside the instance's worktree root, and deletes nothing",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const outside = yield* outsideTree("plain")
        const victim = path.join(outside, "keep")

        const exit = yield* Effect.exit(svc.remove({ directory: victim }))

        expectRefusal(exit, victim)
        // The refusal is worth nothing unless the bytes are still on disk.
        expect(yield* exists(path.join(victim, "precious.txt"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "🔴 refuses a `..` traversal that leaves the worktree root",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const root = yield* containerRoot
        const outside = yield* outsideTree("traversal")

        // Built by CONCATENATION, not `path.join`, so the `..` survives into the request: this is the
        // string a naive `startsWith(root)` accepts and a resolve-then-compare guard rejects.
        const traversal = `${root}${path.sep}${path.relative(root, outside)}`
        expect(traversal).toContain("..")
        expect(path.resolve(traversal)).toBe(path.resolve(outside))

        const exit = yield* Effect.exit(svc.remove({ directory: traversal }))

        expectRefusal(exit, traversal)
        expect(yield* exists(path.join(outside, "keep", "precious.txt"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "🔴 refuses a link inside the worktree root that points out of it",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const root = yield* containerRoot
        const outside = yield* outsideTree("link")
        const link = path.join(root, `escape-${Math.random().toString(36).slice(2)}`)

        // Windows: a JUNCTION, which an unelevated process may create — a file symlink may not.
        const linked = yield* Effect.tryPromise(() =>
          fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir"),
        ).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(link, { recursive: true, force: true })).pipe(Effect.ignore),
        )
        if (!linked) {
          // ⚠️ Said out loud rather than skipped in silence: a link arm that quietly vanishes on a
          // locked-down box is a guard nobody is checking.
          console.warn("worktree containment: could not create a link on this machine — link arm NOT exercised")
          return
        }

        const exit = yield* Effect.exit(svc.remove({ directory: link }))

        expectRefusal(exit, link)
        // The link resolves outward, so an unguarded `rm -r` would have taken the REAL tree with it.
        expect(yield* exists(path.join(outside, "keep", "precious.txt"))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "still cleans an orphaned worktree directory INSIDE the worktree root",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        // The shape the branch exists for: a worktree of ours whose git registry entry is gone and
        // whose directory lingers. `makeWorktreeInfo` places it, and creates nothing on disk.
        const info = yield* svc.makeWorktreeInfo({ name: "orphan" })
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(info.directory, { recursive: true, force: true })).pipe(Effect.ignore),
        )
        yield* Effect.promise(() => fs.mkdir(path.join(info.directory, "sub"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(info.directory, "sub", "leftover.txt"), "x"))

        expect(yield* svc.remove({ directory: info.directory })).toBe(true)
        expect(yield* exists(info.directory)).toBe(false)
      }),
    { git: true },
  )
})
