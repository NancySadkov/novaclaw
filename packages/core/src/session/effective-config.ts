export * as SessionEffectiveConfig from "./effective-config"

import { Context, Effect, Layer } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectFileCache } from "../project-file-cache"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig, type EffectiveConfig } from "./config-resolve"
import { ProjectDefaults } from "./project-defaults"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"

/**
 * THE entry point for "what config is this session running with".
 *
 * 🔴 **One entry point is the whole point.** `resolveSessionConfig` takes the defaults it resolves
 * against as an argument, and eleven call sites passed `EFFECTIVE_CONFIG_DEFAULTS` directly. A
 * layer folded into one of them reached only that reader — so a folder could set `safeMode` while
 * one of its two readers saw the fold, and the same chat would be confined for one decision and not
 * the next. A supervision switch that is half on is indistinguishable from a bug and worse than not
 * offering it (`project-defaults.ts`).
 *
 * So the fold does not live at the readers. It lives here, once, and the readers ask this service.
 * `ProjectDefaults.WIRED` remains the gate on which components a folder may actually influence, but
 * it is now a statement about a single code path rather than a claim about eleven.
 *
 * ⚠️ The project is derived from the SESSION's working folder, not from a directory the caller
 * happens to hold. `permission.ts` used the instance `Location`'s directory, which answers for the
 * instance no matter whose folder was asked about — correct only while every session sits in the
 * instance's own folder, which is not a property the kernel has.
 *
 * ⚠️ Never fails. `SessionStore.get` orDies, and an unreadable project file resolves to no project,
 * so the only outcomes are "resolved with a folder layer" and "resolved without one". A config walk
 * that could fail typed would put a fallback at every reader, and the honest fallback for a
 * permission mode does not exist (see `permission.ts`'s note on that catch).
 */

export interface Resolution {
  /** The effective config: the folder's tune folded under the parent chain and the session's row. */
  readonly config: EffectiveConfig
  /**
   * The layer the chain resolved AGAINST — the shipped defaults with the folder's applied tune on
   * top, before any session declared anything.
   *
   * Reported because the introspection view resolves every PREFIX of the chain to find where each
   * value last moved, and it must run that against the same base the turn did. Handed the shipped
   * defaults instead, it would report a folder-supplied value as coming from the instance.
   */
  readonly defaults: EffectiveConfig
  /** The tune components the folder actually contributed. */
  readonly applied: readonly ProjectFile.TuneFeature[]
  /** Declared and refused, because the folder may not loosen what a lower layer already set. */
  readonly refused: readonly ProjectFile.TuneFeature[]
  /** Declared, allowed, and not applied because a reader of it does not fold yet (`WIRED`). */
  readonly deferred: readonly ProjectFile.TuneFeature[]
  /** The project file that supplied the tune, when one governs the session's folder. */
  readonly project?: { readonly root: string; readonly file: string }
}

export interface Interface {
  /** The full resolution, including where the folder layer came from and what it could not do. */
  readonly resolution: (sessionID: SessionSchema.ID) => Effect.Effect<Resolution>
  /** The effective config alone — what almost every reader wants. */
  readonly resolve: (sessionID: SessionSchema.ID) => Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionEffectiveConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionStore.Service
    const projects = yield* ProjectFileCache.Service

    const resolution = Effect.fn("SessionEffectiveConfig.resolution")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      // No session means no folder, and the chain walk below returns an empty chain — so the answer
      // is the shipped defaults. Resolving anyway (rather than short-circuiting) keeps this method's
      // result identical to what the readers computed before, for a session that vanished mid-turn.
      const found = session ? yield* projects.read(session.location.directory) : ProjectFileCache.EMPTY
      const folded = ProjectDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, found.tune)
      const config = yield* resolveSessionConfig(folded.defaults, sessionID, (id) =>
        sessions.get(id as SessionSchema.ID),
      )
      return {
        config,
        defaults: folded.defaults,
        applied: folded.applied,
        refused: folded.refused,
        deferred: folded.deferred,
        ...(found.root !== undefined && found.file !== undefined
          ? { project: { root: found.root, file: found.file } }
          : {}),
      } satisfies Resolution
    })

    return Service.of({
      resolution,
      resolve: Effect.fn("SessionEffectiveConfig.resolve")(function* (sessionID: SessionSchema.ID) {
        return (yield* resolution(sessionID)).config
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, ProjectFileCache.node],
})
