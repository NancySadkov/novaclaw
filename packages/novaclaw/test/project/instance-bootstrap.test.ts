import { afterEach, expect } from "bun:test"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node])))

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent invariant.
//
// ⚠️ COVERAGE GAP, stated plainly: the "did bootstrap run at this boundary?" probe used to be a V1
// plugin `config` hook writing a marker file. The V1 plugin arm is deleted, and InstanceBootstrap
// has no other externally observable side effect, so the three boundary assertions
// (InstanceStore.provide / InstanceStore.reload / CLI bootstrap) went with it rather than be
// replaced by a probe that cannot fail. Restoring them wants a recording stub bound to the
// `@novaclaw/InstanceBootstrap` tag, which is a stronger test than the marker ever was — that is
// the follow-up. What remains below is the disposal boundary, which is directly observable.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  return { directory: dir }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)
