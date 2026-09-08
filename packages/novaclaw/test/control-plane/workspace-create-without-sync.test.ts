import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { ProjectV2 } from "@novaclaw/core/project"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { AbsolutePath } from "@novaclaw/core/schema"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

/**
 * ─── A CREATION THAT WORKED MUST NOT BE REPORTED AS A FAILURE ────────────────────────────────────
 *
 * 🔴 `Workspace.create` writes the row, creates the workspace on disk through its adapter, and then
 * ran `Effect.all([waitEvent(Status), startSync(info)])` — unconditionally. `startSync` is a no-op
 * when experimental workspaces are off, so nothing ever emitted a `Status` event, the wait burned its
 * full deadline and FAILED, and the failure took the whole `Effect.all` — and with it a `create`
 * whose database row and on-disk workspace were both already there.
 *
 * The caller therefore waited five seconds to be told that a workspace which exists does not. That is
 * ruling 2 inverted, and it is the worse direction: the operator's rational next move is to create it
 * again.
 *
 * ⚠️ **Why the whole suite was blind to it.** `test/preload.ts` sets
 * `NOVACLAW_EXPERIMENTAL_WORKSPACES=true` for every test in the package, so the only configuration
 * that reaches the defect is the DEFAULT one. These two suites pin both settings of the flag against
 * the same creation, because a fix that simply deleted the wait would pass the first alone.
 */

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const suite = (experimentalWorkspaces: boolean) =>
  testEffect(
    Layer.mergeAll(
      testStateLayer,
      Database.defaultLayer,
      ProjectV2.defaultLayer,
      workspaceLayerWithRuntimeFlags({ experimentalWorkspaces }),
    ).pipe(Layer.provide(Ripgrep.defaultLayer)),
  )

const resolveOrigin = (dir: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectV2.Service
    return (yield* projects.resolve(AbsolutePath.make(dir))).id
  })

/**
 * Create one local workspace and report how long the call took.
 *
 * ⚠️ The elapsed time is half the assertion, not colour: the shipped failure was a five-second wait
 * for an event with no sender, so a fix that returned the right verdict late would still be the bug.
 * Measured with the real clock — `it.live` below — because the claim IS a duration.
 */
const timedCreate = (input: { dir: string; type: string }) =>
  Effect.gen(function* () {
    const directory = path.join(input.dir, `.${input.type}`)
    const origin = yield* resolveOrigin(input.dir)
    registerAdapter(origin, input.type, localAdapter(directory))
    const workspace = yield* Workspace.Service

    // Every `Status` this creation publishes, in order. It is the event the wait was waiting for, so
    // whether one exists at all is the mechanism both suites turn on.
    const statuses: string[] = []
    const listen = (event: GlobalEvent) => {
      if (event.payload.type === Workspace.Event.Status.type) statuses.push(String(event.workspace))
    }
    GlobalBus.on("event", listen)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listen)))

    const started = Date.now()
    const info = yield* workspace.create({ type: input.type, branch: null, extra: null, origin })
    return { info, elapsed: Date.now() - started, directory, statuses }
  })

/** Comfortably below the 5 s deadline the old path spent, and comfortably above a healthy local one. */
const PROMPT_MS = 2_000

describe("Workspace.create with experimental workspaces OFF", () => {
  const it = suite(false)

  it.live("reports the creation it actually performed, as a success, promptly", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const { info, elapsed, statuses } = yield* timedCreate({ dir, type: "local-flag-off" })

      // The verdict. Before the fix this effect failed here, having already written everything below.
      expect(info.id).toBeTruthy()
      expect(info.type).toBe("local-flag-off")

      // ...and it is not a verdict about nothing: the row it reports really is in the database.
      const stored = yield* Workspace.use.get(info.id)
      expect(stored?.id).toBe(info.id)

      // 🔴 The mechanism, asserted rather than assumed: with sync off NOTHING publishes a `Status` for
      // this workspace, so the wait that used to be armed here could only ever have expired.
      expect(statuses).not.toContain(String(info.id))

      // The other half of the defect. 5 s was the wait; anything near it means the wait is still armed.
      expect(elapsed).toBeLessThan(PROMPT_MS)
    }),
  )
})

describe("Workspace.create with experimental workspaces ON", () => {
  const it = suite(true)

  /**
   * ⚠️ **What this control can and cannot show.** It shows that the enabled path still publishes its
   * `Status` and still answers with a success, so the fix is not "turn sync off for everyone". It does
   * NOT distinguish an armed wait from a deleted one: for a LOCAL target `startSync` publishes and
   * returns in the same step, so both orderings look identical from out here, and the only shape that
   * would separate them is a remote target's forked reconnect loop — an unbounded backoff running past
   * the end of a test, which is a worse thing to introduce than this limit is to state. The armed case
   * is held instead by the deadline that already covers it and by `create` reading one named predicate.
   */
  it.live("the enabled path still publishes its status and still reports success", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const { info, elapsed, statuses } = yield* timedCreate({ dir, type: "local-flag-on" })

      expect(info.id).toBeTruthy()
      const stored = yield* Workspace.use.get(info.id)
      expect(stored?.id).toBe(info.id)

      // The enabled path is unchanged: a sender exists, the status is published, the answer is a
      // success. This is what stops the OFF suite from being satisfiable by disabling sync outright.
      expect(statuses).toContain(String(info.id))

      // Still prompt: with a publisher present the wait is satisfied, not endured.
      expect(elapsed).toBeLessThan(PROMPT_MS)
    }),
  )
})
