export * as ProjectV2 from "./project"
export * as Project from "./project"

// T3 (notes/entities.md): the project ENTITY is gone — this module is only the derivation of a
// location's two substrate attributes: the VCS root directory and the rename-stable `origin`
// hash (git remote URL hash → repo-local cached id → root-commit hash → "global"). Nothing is
// persisted here; identity is recomputed from the repo itself.

import { Context, Effect, Layer, Schema } from "effect"
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

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const repo = yield* git.repo.discover(input)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const id = (yield* remote(repo)) ?? (yield* cached(repo.commonDirectory)) ?? (yield* root(repo))
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
