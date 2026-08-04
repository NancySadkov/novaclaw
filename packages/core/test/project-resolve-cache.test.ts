import { describe, expect } from "bun:test"
import os from "os"
import path from "path"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Git } from "@novaclaw/core/git"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { testEffect } from "./lib/effect"

/**
 * `Project.resolve` caches — the HIT, the MISS, and the bound.
 *
 * ⚠️ **No real git here, and that is the point.** The invariant under test is *how many times git
 * is asked*, and a wall-clock suite cannot assert that: it can only observe that a run got faster,
 * which on this box swings ±30% between identical runs anyway (todo/test-speed.md). So `Git.Service`
 * is a stub that COUNTS its three calls and answers from a table, and the whole file is arithmetic —
 * it runs in milliseconds and it fails for exactly one reason.
 *
 * `it.effect` puts the body on Effect's TestClock, which is what makes the TTL testable at all:
 * `Project.resolve` reads `Clock.currentTimeMillis`, so virtual time expires an entry with no sleep.
 * (Sibling precedent: `messenger-gateway.test.ts`.)
 */

const abs = (value: string) => AbsolutePath.make(value)

/** Where the fake repositories live. `.git` under each, so `commonDirectory` differs per repo. */
const repoAt = (root: string) =>
  new Git.Repository({
    worktree: abs(root),
    gitDirectory: abs(path.join(root, ".git")),
    commonDirectory: abs(path.join(root, ".git")),
  })

interface Counts {
  discover: number
  remote: number
  rootCommits: number
}

/**
 * A `Git.Service` that counts and answers from `repos`: input directory → the repository it
 * discovers to, or `undefined` for "not a repository".
 *
 * Everything `Project` never calls dies loudly rather than returning a plausible value — a stub that
 * silently answers a call the code under test was not supposed to make is how a test starts
 * measuring the wrong thing.
 */
function stubGit(input: {
  repos: Record<string, Git.Repository | undefined>
  /** commonDirectory → the `origin` url this repository reports, if any. */
  remotes?: Record<string, string>
  /** commonDirectory → its root commit. */
  roots?: Record<string, string>
}) {
  const counts: Counts = { discover: 0, remote: 0, rootCommits: 0 }
  const unused = (name: string) => () => Effect.die(new Error(`Project must not call Git.${name}`))
  const layer = Layer.succeed(
    Git.Service,
    Git.Service.of({
      repo: {
        discover: (directory: AbsolutePath) =>
          Effect.sync(() => {
            counts.discover++
            return input.repos[directory]
          }),
        clone: unused("repo.clone"),
        create: unused("repo.create"),
      },
      remote: {
        get: (repository: Git.Repository) =>
          Effect.sync(() => {
            counts.remote++
            return input.remotes?.[repository.commonDirectory]
          }),
      },
      history: {
        head: unused("history.head"),
        branch: unused("history.branch"),
        defaultRemoteBranch: unused("history.defaultRemoteBranch"),
        rootCommits: (repository: Git.Repository) =>
          Effect.sync(() => {
            counts.rootCommits++
            const root = input.roots?.[repository.commonDirectory]
            return root ? [root] : []
          }),
      },
      sync: unused("sync") as never,
      change: unused("change") as never,
      worktree: unused("worktree") as never,
      index: unused("index") as never,
      tree: unused("tree") as never,
    } as unknown as Git.Interface),
  )
  return { counts, layer }
}

/**
 * These paths are never created and never written to — the stub answers for them, and the only
 * thing that ever touches the disk is `Project`'s own read of `<commonDirectory>/novaclaw`, which
 * misses. They still live under the temp dir rather than at the drive root, so nothing here even
 * LOOKS like the write-scope violation AGENTS.md principle 11 exists to prevent.
 */
const scratch = path.join(os.tmpdir(), "novaclaw-project-cache-test")
const A = repoAt(path.join(scratch, "repo-a"))
const B = repoAt(path.join(scratch, "repo-b"))
const SUB = path.join(A.worktree, "packages", "core")
const PLAIN = path.join(scratch, "not-a-repo")

/** The one fixture every test here uses: two repositories, each identified by its root commit. */
const fixture = () =>
  stubGit({
    repos: { [A.worktree]: A, [SUB]: A, [B.worktree]: B, [PLAIN]: undefined },
    roots: { [A.commonDirectory]: "aaaaaaa", [B.commonDirectory]: "bbbbbbb" },
  })

/** Build `Project` over a counting git, run the body, hand back what git was asked. */
const withGit = <A2, E>(
  git: ReturnType<typeof stubGit>,
  body: (project: ProjectV2.Interface) => Effect.Effect<A2, E, never>,
) =>
  ProjectV2.Service.pipe(
    Effect.flatMap(body),
    Effect.provide(ProjectV2.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(git.layer))),
  )

const it = testEffect(Layer.empty)

describe("ProjectV2.resolve cache", () => {
  it.effect("HIT: the same directory is discovered and identified once", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const first = yield* project.resolve(abs(A.worktree))
        const second = yield* project.resolve(abs(A.worktree))

        expect(second.id).toBe(first.id)
        expect(second.directory).toBe(first.directory)
        expect(second.vcs?.store).toBe(first.vcs?.store)
        expect(git.counts).toEqual({ discover: 1, remote: 1, rootCommits: 1 })
      }),
    )
  })

  it.effect("HIT: a second directory in the SAME repository reuses the identity", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const top = yield* project.resolve(abs(A.worktree))
        const nested = yield* project.resolve(abs(SUB))

        expect(nested.id).toBe(top.id)
        // A new input directory HAS to be discovered — only `discover` knows which repository it
        // belongs to. What must not be paid twice is the identity, which is read out of the common
        // directory the two share.
        expect(git.counts).toEqual({ discover: 2, remote: 1, rootCommits: 1 })
      }),
    )
  })

  it.effect("MISS: a different repository is resolved from scratch", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const a = yield* project.resolve(abs(A.worktree))
        const b = yield* project.resolve(abs(B.worktree))

        expect(a.id).toBe(ProjectV2.ID.make("aaaaaaa"))
        expect(b.id).toBe(ProjectV2.ID.make("bbbbbbb"))
        expect(git.counts).toEqual({ discover: 2, remote: 2, rootCommits: 2 })
      }),
    )
  })

  it.effect("the entry expires: past the TTL, git is asked again", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        yield* project.resolve(abs(A.worktree))
        yield* TestClock.adjust(Duration.sum(ProjectV2.CacheTTL, Duration.millis(1)))
        const after = yield* project.resolve(abs(A.worktree))

        expect(after.id).toBe(ProjectV2.ID.make("aaaaaaa"))
        expect(git.counts).toEqual({ discover: 2, remote: 2, rootCommits: 2 })
      }),
    )
  })

  it.effect("just under the TTL the entry is still live", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        yield* project.resolve(abs(A.worktree))
        yield* TestClock.adjust(Duration.subtract(ProjectV2.CacheTTL, Duration.millis(1)))
        yield* project.resolve(abs(A.worktree))

        expect(git.counts).toEqual({ discover: 1, remote: 1, rootCommits: 1 })
      }),
    )
  })

  // ⚠️ The title deliberately avoids the words "git" + "init" adjacent. `git-fixture-ledger.test.ts`
  // sweeps this directory's raw source for hand-rolled repository creation; it strips COMMENTS but not
  // string literals, so a test TITLE containing that phrase is indistinguishable from code to it. This
  // file spawns no git at all — every repository here is a stub — so a ledger entry would have made
  // the ledger's own claim false. Renaming was the honest fix; see the note in that file.
  it.effect("a NON-repository is never cached — a newly created repository must be seen at once", () => {
    const git = fixture()
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const first = yield* project.resolve(abs(PLAIN))
        const second = yield* project.resolve(abs(PLAIN))

        expect(first.id).toBe(ProjectV2.ID.make("global"))
        expect(second.id).toBe(ProjectV2.ID.make("global"))
        // Re-walked both times, and it is free: `discover` spawns no git process when there is no
        // `.git` to find, so there is nothing here to save by going stale.
        expect(git.counts).toEqual({ discover: 2, remote: 0, rootCommits: 0 })
      }),
    )
  })

  it.effect("a repository with no identity YET is never cached", () => {
    // No remote, no root commit — `git init` with nothing committed. The one state that changes on
    // its own within seconds, so the answer must not be pinned for the TTL.
    const git = stubGit({ repos: { [A.worktree]: A } })
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const first = yield* project.resolve(abs(A.worktree))
        const second = yield* project.resolve(abs(A.worktree))

        expect(first.id).toBe(ProjectV2.ID.make("global"))
        expect(second.id).toBe(ProjectV2.ID.make("global"))
        // The repository itself is cached (`discover` 1) — only the missing identity is re-read.
        expect(git.counts).toEqual({ discover: 1, remote: 2, rootCommits: 2 })
      }),
    )
  })

  it.effect("the remote wins over the root commit, and is what gets cached", () => {
    const git = stubGit({
      repos: { [A.worktree]: A },
      remotes: { [A.commonDirectory]: "git@github.com:owner/repo.git" },
      roots: { [A.commonDirectory]: "aaaaaaa" },
    })
    return withGit(git, (project) =>
      Effect.gen(function* () {
        const first = yield* project.resolve(abs(A.worktree))
        const second = yield* project.resolve(abs(A.worktree))

        expect(second.id).toBe(first.id)
        expect(first.id).not.toBe(ProjectV2.ID.make("aaaaaaa"))
        // `rootCommits` is never reached when a remote answers — so the expensive O(history) call
        // is paid zero times here, and the cheap one exactly once.
        expect(git.counts).toEqual({ discover: 1, remote: 1, rootCommits: 0 })
      }),
    )
  })
})
