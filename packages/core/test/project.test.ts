import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Hash } from "@novaclaw/core/util/hash"
import { git, gitText, repo } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(ProjectV2.node))

function remoteID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

/**
 * Every repository here comes from the shared `test/fixture/git.ts` template — built once per
 * process, handed out as an `fs.cp` copy. This file used to hand-roll its own `initRepo`, eight git
 * processes deep, ~11 times over ten tests; see `git-fixture-ledger.test.ts` for the ratchet that
 * keeps it that way.
 *
 * ⚠️ Every copy of a given template shares one root-commit hash, so two repositories built the same
 * way now resolve to the same id where they used to differ. Nothing here asserts otherwise: the
 * root-commit expectations all read the hash back out of the repository under test (`rootCommit`
 * below) rather than comparing two repositories to each other.
 */
async function rootCommit(dir: string) {
  return (await gitText(dir, "rev-list", "--max-parents=0", "HEAD")).trim()
}

describe("ProjectV2.resolve", () => {
  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(path.resolve(result.directory)).toBe(path.parse(tmp.path).root)
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("returns git global for repo with no commits and no remote", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { commit: false }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("falls back to root commit when origin is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers normalized origin over root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { origin: "git@github.com:Acme/App.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("normalizes ssh and https remotes to the same id", () =>
    Effect.gen(function* () {
      const ssh = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const https = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(ssh.path, {}, { origin: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => repo(https.path, {}, { origin: "https://github.com/owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).toBe(remoteID("github.com/owner/repo"))
      expect(b.id).toBe(a.id)
    }),
  )

  it.live("ignores file remotes and falls back to root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { origin: `file://${tmp.path}` }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("returns previous cached id from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { origin: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "novaclaw"), "old-id"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/owner/repo"))
    }),
  )

  it.live("does not write the cache while resolving", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { origin: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "novaclaw")).exists())).toBe(false)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(tmp.path))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("linked worktree returns opened worktree directory and previous from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => repo(tmp.path, {}, { origin: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "novaclaw"), "old-id"))
      // Scenario git, not scenery: the linked worktree is what this test is about.
      yield* Effect.promise(() => git(tmp.path, "worktree", "add", worktree, "-b", `test-${Date.now()}`))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
      expect(result.vcs?.type).toBe("git")
    }),
  )
})
