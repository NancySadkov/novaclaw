import { InstanceState } from "@/effect/instance-state"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { FSUtil } from "@novaclaw/core/fs-util"
import nodePath from "node:path"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Worktree } from "@/worktree"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorktreeApiError } from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const worktreeSvc = yield* Worktree.Service

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    // 🗑️ `gitignoreProposal`, `project` and `projectWrite` stood here: the three handlers behind
    // `GET`/`POST /api/project`, which read the folder's declaration, reported what it contributed
    // (including the folder stance from `SessionEffectiveConfig.folderStance`), proposed the
    // `.gitignore` import, and wrote the file back. All three went with the mechanism on 2026-09-16.
    // The route they served is gone from the group as well, so this is a deletion rather than a
    // disabled handler.
    return handlers
      .handle("worktreeCreate", worktreeCreate)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
