export * as ProjectV2 from "./project"
export * as Project from "./project"

// T3 (notes/entities.md): the project ENTITY is gone — this module is only the derivation of a
// location's two substrate attributes: the VCS root directory and the rename-stable `origin`
// hash (git remote URL hash → repo-local cached id → root-commit hash → "global"). Nothing is
// persisted here; identity is recomputed from the repo itself.

import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectID } from "@novaclaw/schema/project-id"

export const ID = ProjectID
export type ID = typeof ID.Type

export const Vcs = Schema.Struct({
  type: Schema.Literals(["git"]),
  store: AbsolutePath,
}).annotate({ identifier: "Project.Vcs" })
export type Vcs = typeof Vcs.Type

export interface Resolved {
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
}

/**
 * How long a resolved repository / identity may be reused before git is asked again.
 *
 * `resolve` costs **five git subprocesses** on a miss — `discover` alone is three (`rev-parse
 * --show-toplevel`, `--git-dir`, `--git-common-dir`), plus `remote get-url` and `rev-list
 * --max-parents=0 HEAD`, and that last one is O(history): on a large repository it walks every
 * commit. It is called from at least three independent places for the SAME repository
 * (`InstanceStore.boot`, `Location.layer`, `MoveSession` twice per move), none of which can see
 * each other's answer — measured 2026-07-30 over `test/server/httpapi-instance-context.test.ts`:
 * **14 resolves, 9 distinct directories, 7 distinct repositories.**
 *
 * **What invalidates an entry: nothing but this timer.** There is no watch, no event and no
 * fingerprint — so within the window a repository the user re-inits, moves, or adds a remote to is
 * answered from the previous reading. Five seconds is chosen against both ends of that: it is three
 * orders of magnitude longer than the bursts it exists to coalesce (boot + location build are
 * milliseconds apart), and shorter than a person can run `git remote add` in one window and look at
 * NovaClaw in another. Per todo.md ruling 2 a confidently wrong answer is worse than a slow correct
 * one, so the two shapes that would make it wrong for LONGER than the timer are both refused below:
 * a directory that is not a repository is never cached, and neither is a repository with no
 * identity yet. The cache only ever holds a positive, settled answer.
 *
 * (For scale: `InstanceStore` already memoizes its own `resolve` result for the whole life of the
 * process with no expiry at all, so this is strictly fresher than what the app already serves.)
 */
export const CacheTTL = Duration.seconds(5)

export class Service extends Context.Service<Service, Interface>()("@novaclaw/ProjectV2") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service

    // The repo-local cached id (`<gitdir>/novaclaw`) written by pre-T3 installs: still honored
    // as the remote-less tiebreak so existing repos keep their identity; never written anymore.
    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "novaclaw")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      try {
        const parsed = new URL(value)
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      } catch {
        const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
        if (scp) return parts(scp[2], scp[3])
        return undefined
      }
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    // ─── the two caches (see `CacheTTL` above for the lifetime and what invalidates them) ─────
    //
    // Two levels, because the two halves of a resolve are keyed by different things and the
    // measurement says both keys earn their place:
    //
    //  · REPOSITORY, keyed by the INPUT directory — what `discover` walked up from. Saves the
    //    three `rev-parse` calls when the same directory is resolved again (5 of the 14 measured
    //    resolves were a second reading of a directory already read).
    //  · IDENTITY, keyed by the repository's COMMON directory — what `remote`/`novaclaw`/root-commit
    //    are actually read out of. Saves `remote get-url` + `rev-list` when a DIFFERENT directory
    //    turns out to be the same repository: a subdirectory, a session opened deeper in the tree,
    //    a linked worktree (all worktrees of one repository share one common directory and
    //    therefore one identity), or `MoveSession`'s source/destination pair.
    //
    // A directory-only key is what `InstanceStore` already has, and it is not enough on its own —
    // which is exactly why the second level exists.
    //
    // Measured 2026-07-30 with `GIT_TRACE` over `novaclaw/test/server/httpapi-instance-context.test.ts`
    // — a process count, not a wall clock, because this box swings ±2× under load: **85 → 56 git
    // processes**, which is exactly the 5×5 + 2×2 the probe above predicts. Median wall over five
    // interleaved runs each: 9.4 s → 7.6 s.
    const ttl = Duration.toMillis(CacheTTL)
    interface Entry<A> {
      readonly value: A
      readonly at: number
    }
    const repositories = new Map<string, Entry<Git.Repository>>()
    const identities = new Map<string, Entry<ID>>()

    const hit = <A>(store: Map<string, Entry<A>>, key: string, at: number) => {
      const entry = store.get(key)
      if (entry === undefined) return undefined
      if (at - entry.at >= ttl) {
        store.delete(key)
        return undefined
      }
      return entry
    }

    /**
     * Write, and drop whatever has expired while we were not looking.
     *
     * Without this the maps grow one permanent row per directory ever resolved, in a process that
     * is meant to run for days. The sweep is O(entries) on a MISS only, and the entry count is the
     * number of distinct directories a user has open — tens, not thousands.
     */
    const keep = <A>(store: Map<string, Entry<A>>, key: string, value: A, at: number) => {
      for (const [existing, entry] of store) if (at - entry.at >= ttl) store.delete(existing)
      store.set(key, { value, at })
    }

    const discovered = Effect.fnUntraced(function* (input: AbsolutePath, at: number) {
      const cachedRepo = hit(repositories, input, at)
      if (cachedRepo) return cachedRepo.value

      const repo = yield* git.repo.discover(input)
      // ⚠️ A directory that is NOT a repository is deliberately never cached. It costs nothing to
      // re-answer — `discover` walks for `.git` with plain fs and spawns no git process when it
      // finds none — and caching it would make `git init` in a folder the user already has open
      // keep reporting "not a repository" for the whole TTL. Free correctness, no lost speed.
      if (repo) keep(repositories, input, repo, at)
      return repo
    })

    const identify = Effect.fnUntraced(function* (repo: Git.Repository, at: number) {
      const cachedID = hit(identities, repo.commonDirectory, at)
      if (cachedID) return cachedID.value

      const id = (yield* remote(repo)) ?? (yield* cached(repo.commonDirectory)) ?? (yield* root(repo))
      // ⚠️ Same rule as above, one level down: `undefined` means a repository that has no identity
      // YET (no remote, no cached id, no commits) — the one state that is about to change on its
      // own, typically within seconds of `git init`. Only a settled answer is kept.
      if (id !== undefined) keep(identities, repo.commonDirectory, id, at)
      return id
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const at = yield* Clock.currentTimeMillis
      const repo = yield* discovered(input, at)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const id = yield* identify(repo, at)
      return {
        id: id ?? ID.global,
        directory: repo.worktree,
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    return Service.of({ resolve })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))
export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node],
})
