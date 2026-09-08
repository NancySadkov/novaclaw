import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Effect } from "effect"
import { Worktree } from "../../src/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Worktree.node))
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

describe("Worktree.remove", () => {
  /**
   * 🔴 Ruling 1 for the 2026-08-07 data-loss fix. `git worktree remove --force` was HARDCODED, so a
   * worktree with uncommitted changes was deleted silently — git's own guard switched off at the one
   * call site that would have used it. `force` now defaults to safe.
   *
   * ⚠️ Both halves are asserted deliberately. A test that only checks the refusal would pass against a
   * `remove` that refuses everything, and one that only checks `force: true` would pass against the
   * old unconditional behaviour. It is the PAIR that pins the default.
   */
  it.instance(
    "🔴 refuses a worktree with uncommitted work, and removes it when forced",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `dirty-${Date.now().toString(36)}`
        const dir = path.join(root, "..", name)
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
        )

        yield* Effect.promise(() => $`git worktree add --detach ${dir} HEAD`.cwd(root).quiet())
        // The work that must not be destroyed without saying so. Untracked is enough for git to refuse.
        yield* Effect.promise(() => Bun.write(path.join(dir, "uncommitted.txt"), "work in progress"))

        const refused = yield* svc.remove({ directory: dir }).pipe(Effect.flip)
        expect(refused._tag).toBe("WorktreeDirtyError")
        // The directory travels on the error, not just in the sentence: a client offering
        // "delete anyway" needs to know WHICH worktree without parsing the message.
        expect((refused as { directory?: string }).directory).toBe(dir)
        // The directory is still there — the refusal is not a partial removal reported as an error.
        expect(yield* Effect.promise(() => fs.stat(dir).then(() => true).catch(() => false))).toBe(true)

        expect(yield* svc.remove({ directory: dir, force: true })).toBe(true)
        expect(yield* Effect.promise(() => fs.stat(dir).then(() => true).catch(() => false))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `novaclaw/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `novaclaw/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        // `force: true` because this test deliberately writes an untracked `tracked.txt` above to give
        // fsmonitor something to watch — so the worktree is dirty BY CONSTRUCTION. Its subject is
        // fsmonitor teardown, not the dirty guard added 2026-08-07, and without the flag it would be
        // asserting the guard instead. ⚠️ This is exactly the caller the flag change was meant to surface.
        const ok = yield* svc.remove({ directory: dir, force: true })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )
})
