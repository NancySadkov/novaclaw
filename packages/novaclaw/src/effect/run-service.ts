import { Effect, Fiber, type Layer } from "effect"
import * as Context from "effect/Context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { InstanceContext } from "@/project/instance-context"
import { makeRuntime as coreMakeRuntime } from "@novaclaw/core/effect/runtime"

type Refs = {
  instance?: InstanceContext
  workspace?: string
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  if (!refs.instance && !refs.workspace) return effect
  if (!refs.instance) return effect.pipe(Effect.provideService(WorkspaceRef, refs.workspace))
  if (!refs.workspace) return effect.pipe(Effect.provideService(InstanceRef, refs.instance))
  return effect.pipe(
    Effect.provideService(InstanceRef, refs.instance),
    Effect.provideService(WorkspaceRef, refs.workspace),
  )
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const workspace = WorkspaceContext.workspaceID
  const fiber = Fiber.getCurrent()
  return attachWith(effect, {
    instance: fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined,
    workspace: workspace ?? (fiber ? Context.getReferenceUnsafe(fiber.context, WorkspaceRef) : undefined),
  })
}

/**
 * The instance-aware runtime: `@novaclaw/core`'s factory with `attach` as its wrapper, so every
 * effect it runs inherits `InstanceRef`/`WorkspaceRef` from the current fiber.
 *
 * ⚠️ An ALIAS, not a second implementation. This was a copy of core's twenty-line body, and the
 * attach step was the only difference — which made "does this run see its instance?" a property of
 * which module the caller imported. `test/effect/run-service.test.ts` asserts the inheritance for
 * this one; core's identity default is asserted by its own consumer (`npm.ts`, under `global.cache`).
 */
export const makeRuntime = <I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) =>
  coreMakeRuntime<I, S, E>(service, layer, attach)
