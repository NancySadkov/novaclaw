import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Git } from "@novaclaw/core/git"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { branch, commit, git as gitCmd, repo, withRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

// Here the git process IS the subject — `Git.Service` is a wrapper over git, and clone / fetch /
// checkout / reset / worktree / write-tree are exactly what is being asserted. None of that is
// collapsed. What IS scenery is the repository being cloned from or operated on, so those come from
// a template built once per process and copied (test/fixture/git.ts).
describe("Git", () => {
  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, { branch: "feature/docs" })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

// `repo.discover` is the hottest git call the product makes — `Project.resolve` reaches it for every
// request, measured at 111 `rev-parse` processes in ONE test file. It used to spawn three of them
// (`--show-toplevel`, `--git-dir`, `--git-common-dir`); `rev-parse` answers all three in one
// invocation, one value per line in argument order, so it now spawns one.
//
// The collapse is only safe WITH the fallback, and this is the case that proves it. Measured on
// git-for-windows: when `--show-toplevel` is not answerable the whole invocation dies — exit 128,
// **nothing printed**, not even the two queries that would have succeeded. The three-spawn version
// tolerated that by construction, because only the latter two were required and a failed
// `--show-toplevel` fell back to the containing directory. So a naive one-call rewrite turns a
// repository we resolve today into `undefined` — a silent regression with no compile error and no
// failing assertion anywhere else in this file.
//
// `core.bare = true` on a repository whose `.git` is still on disk is that shape, reachable with
// real git: the `.git` walk still finds it, so `discover` runs, and only `--show-toplevel` fails.
describe("Git repo.discover", () => {
  it.live("falls back when --show-toplevel is unanswerable, instead of losing the repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => repo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const git = yield* Git.Service

      // Sanity first, so a failure here reads as "the fixture broke", not "the fallback broke".
      const before = yield* git.repo.discover(directory)
      expect(before?.worktree).toBe(directory)

      yield* Effect.promise(() => gitCmd(root.path, "config", "core.bare", "true"))

      const found = yield* git.repo.discover(directory)
      // The assertion that matters is `toBeDefined`: the pre-collapse code answered here, so
      // answering `undefined` would be a capability we silently lost.
      expect(found, "a bare-flagged repository must still resolve — this is what the fallback buys").toBeDefined()
      expect(found?.worktree).toBe(directory)
      expect(found?.gitDirectory).toBe(AbsolutePath.make(path.join(directory, ".git")))
      expect(found?.commonDirectory).toBe(found?.gitDirectory)
    }),
  )
})

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      // An empty root commit is all this test needs to exist; the worktree calls below are the subject.
      yield* Effect.promise(() => repo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      // Named `main` rather than `repo`: a local `const repo` shadows the imported fixture `repo()`
      // for the WHOLE function body, so line 73 above hit its temporal dead zone. Caught by running
      // the suite (2026-07-28) — the shadow compiles green.
      const main = yield* git.repo.discover(directory)
      if (!main) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: main, directory: worktree })

      expect((yield* git.worktree.list(main)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(main.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(main.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({ repository: linked, directory: worktree, force: false })
      expect((yield* git.worktree.list(main)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})

describe("Git trees", () => {
  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      // Same committed shape as Snapshot's scoped fixture, so both suites share ONE built template.
      yield* Effect.promise(() => repo(root.path, { "scope/tracked.txt": "one\n", "outside.txt": "outside\n" }))
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 1 })
      expect(diffs.map((item) => [item.path, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      const preview = yield* git.tree.preview({ repository, current: after, files, context: 1 })
      expect(preview).toHaveLength(1)
      expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )
})
