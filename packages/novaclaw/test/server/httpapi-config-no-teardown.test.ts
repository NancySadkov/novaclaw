import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

/**
 * ─── v0.2.0-prep B7, FINAL STEP: a settings change is not a reboot (ruling 3) ────────────────────
 *
 * `PATCH /config` used to end in `markInstanceForDisposal`, so **saving a preference tore the
 * instance down**: every `InstanceState` cache invalidated, the whole per-location layer graph
 * released, and with it the user's terminals, every pending permission ask and every MCP child —
 * then a ~1 s location boot on the next request. That teardown was also the ONLY reason an edited
 * setting applied at all (root cause S1: everything snapshotted runtime-editable state at
 * layer-build time). B7's tiers replaced it cure by cure; this file is the check that the teardown
 * is gone AND that the change still lands.
 *
 * ⚠️ Both halves are load-bearing, and each alone is a trap:
 *  · "no disposal" alone passes if the write silently stopped applying — the exact silent failure
 *    this step risks, which is why the agent description is read back THROUGH `GET /agent`, i.e.
 *    through the location graph's `AgentV2`, not out of the config stores. `GET /config` would prove
 *    nothing: it answers from `ConfigStoreWrite.overlay`, which reads SQLite directly.
 *  · "still applies" alone passes with the teardown restored — that was the old behaviour.
 *
 * The disposal observer is not a sleep-and-hope: `disposeMiddleware` awaits `store.dispose(...)`
 * before the response is handed back, so by the time the PATCH resolves a teardown would already
 * have emitted `server.instance.disposed`. And the observer is proved live in the same test by a
 * REAL disposal at the end — an absence assertion with nothing to show it can fire is decoration.
 *
 * ⚠️ `Server.Default().app` deliberately, not `httpapi-layer.ts`: `HttpRouter.serve` there is
 * constructed WITHOUT `disposeMiddleware`, so a marked instance is never actually disposed and the
 * "no disposal" assertion would be vacuous on that harness.
 */

function app() {
  return Server.Default().app
}

const AGENT = "b7-live-agent"

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

/** Collect `server.instance.disposed` for one directory, for the life of the scope. */
const watchDisposals = (directory: string) =>
  Effect.gen(function* () {
    const seen: string[] = []
    const handler = (event: GlobalEvent) => {
      if (event.payload.type === "server.instance.disposed" && event.directory === directory) seen.push(event.directory)
    }
    GlobalBus.on("event", handler)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", handler)))
    return seen
  })

const patchConfig = (directory: string, body: unknown) =>
  Effect.promise(() =>
    Promise.resolve(
      app().request("/config", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-novaclaw-directory": directory },
        body: JSON.stringify(body),
      }),
    ),
  )

const listAgents = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      Promise.resolve(app().request("/agent", { headers: { "x-novaclaw-directory": directory } })),
    )
    expect(response.status).toBe(200)
    return (yield* Effect.promise(() => response.json())) as { name: string; description?: string }[]
  })

const describedAs = (agents: { name: string; description?: string }[]) =>
  agents.find((agent) => agent.name === AGENT)?.description

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("PATCH /config no longer tears the instance down", () => {
  it.live(
    "the write applies through the live location graph and NOTHING is disposed",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { agents: { [AGENT]: { description: "before" } } } })
      const disposals = yield* watchDisposals(tmp.path)

      // Boot the location and take the BEFORE reading through it. `/agent` is served by
      // `Agent.listV2` inside `locations.get(...)`, i.e. the materialised `AgentV2` — the very state
      // that used to be rebuilt only by the teardown.
      expect(describedAs(yield* listAgents(tmp.path))).toBe("before")
      const registeredWhileBooted = ConfigStoreWrite.registeredReloads("agents")
      expect(registeredWhileBooted).toBeGreaterThan(0)

      const response = yield* patchConfig(tmp.path, { agents: { [AGENT]: { description: "after" } } })
      expect(response.status).toBe(200)

      // ── the whole point of B7 ────────────────────────────────────────────────────────────────
      expect(disposals).toEqual([])

      // ── …and the edit is LIVE anyway, on the location graph that was never rebuilt ───────────
      expect(describedAs(yield* listAgents(tmp.path))).toBe("after")

      // A SECOND edit must also land: a reload that only ever runs once passes the assertion above.
      expect((yield* patchConfig(tmp.path, { agents: { [AGENT]: { description: "again" } } })).status).toBe(200)
      expect(describedAs(yield* listAgents(tmp.path))).toBe("again")
      expect(disposals).toEqual([])

      // ── the observer is live, and the location disposer is still WIRED ───────────────────────
      // A real disposal must (a) reach the bus, which proves the absence assertions above were
      // capable of failing, and (b) release the location's layer graph — observable because closing
      // it runs the `config-agent` plugin's scope finalizer, which deregisters that location's
      // reload. `locationDisposerLayer` (httpapi/lifecycle.ts) is what performs (b); it used to be
      // registered inside the PTY handler group, so this also pins the move off that group.
      yield* Effect.promise(() => disposeAllInstances())
      expect(disposals).toEqual([tmp.path])
      expect(ConfigStoreWrite.registeredReloads("agents")).toBeLessThan(registeredWhileBooted)
    }),
  )
})
