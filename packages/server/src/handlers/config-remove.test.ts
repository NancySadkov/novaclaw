import { describe, expect, test } from "bun:test"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { ConfigCommand } from "@novaclaw/core/config/command"
import { ConfigReference } from "@novaclaw/core/config/reference"
import { Database } from "@novaclaw/core/database/database"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { Effect, Layer, Schema } from "effect"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { AgentHandler } from "./agent"
import { CommandHandler } from "./command"
import { ReferenceHandler } from "./reference"

// The `remove*` config routes (2026-07-28), and the dangling-default cleanup that is the actual
// content of them. Ruling 1: an invariant whose violation compiles green ships with a mechanical
// check. Two violations here compile green and `bun test` alone would not see either — bun
// type-strips, and effect's `HttpApiBuilder.group` enforces "every endpoint is handled" ONLY in
// the type system (there is no runtime completeness check; an unhandled endpoint silently
// registers no route and 404s). So this file drives the REAL registered handler function against
// a REAL SQLite store, rather than a re-implementation of the rule.
//
// The store layers are provided against an in-memory database built here, NOT `*.node`: the
// global nodes resolve their path from `Flag.NOVACLAW_DB` at module load, and `packages/server`
// has no test preload pinning it, so a node-based test would open the developer's real database.

const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)
const decodeCommand = Schema.decodeUnknownSync(ConfigCommand.Info)
const decodeReference = Schema.decodeUnknownSync(ConfigReference.Entry)

const stores = Layer.mergeAll(AgentConfigStore.layer, CommandConfigStore.layer, ReferenceConfigStore.layer).pipe(
  Layer.provide(Database.layerFromPath(":memory:")),
)

type RegisteredHandler = (request: { readonly params: Record<string, string> }) => Effect.Effect<unknown, unknown, any>

// Building a group layer runs `handlerToRoute`, which resolves every middleware the api and the
// group declare out of the ambient context — so they have to EXIST here even though these three
// handlers only touch instance-global stores. Pass-throughs are enough, and honest: the stores
// under test are global nodes, so there is no per-location behaviour to fake, and authorization is
// a transport concern this file is not making claims about.
const middleware = Layer.mergeAll(
  Layer.succeed(
    LocationMiddleware,
    LocationMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect as never),
  ),
  Layer.succeed(
    SchemaErrorMiddleware,
    SchemaErrorMiddleware.of((effect) => effect as never),
  ),
)

/**
 * The handler function the route actually dispatches to, pulled out of the built group layer.
 *
 * `HttpApiBuilder.group` builds a Context holding `{ routes, handlers }` under the group key;
 * `handlers` is keyed by endpoint name. Reading it is what makes "the endpoint is wired" testable
 * without booting an HTTP server — and a missing `.handle(...)` fails here with a named endpoint
 * instead of a 404 nobody is looking for.
 */
async function registeredHandler(group: string, endpoint: string): Promise<RegisteredHandler> {
  const layer = (group === "server.agent"
    ? AgentHandler
    : group === "server.command"
      ? CommandHandler
      : ReferenceHandler) as unknown as Layer.Layer<never, never, never>
  const context = await Effect.runPromise(Effect.scoped(Layer.build(layer)).pipe(Effect.provide(middleware)))
  const key = (Api.groups as Record<string, { readonly key: string }>)[group]!.key
  const built = context.mapUnsafe.get(key) as {
    readonly handlers: Map<string, { readonly handler: RegisteredHandler }>
  }
  const item = built.handlers.get(endpoint)
  expect(item, `${group} registered no handler for "${endpoint}" — the route would 404`).toBeDefined()
  return item!.handler
}

const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, stores) as Effect.Effect<A>)

describe("the config remove routes", () => {
  // Ruling 11: the one contract is `/api/*`, and the legacy set may only shrink. A new route
  // outside it must fail a test, not a review — so assert it over the WHOLE api, not just the
  // three endpoints this commit adds.
  test("every declared endpoint lives under /api/", () => {
    const stray: string[] = []
    for (const group of Object.values(
      Api.groups as Record<
        string,
        { readonly endpoints: Record<string, { readonly method: string; readonly path: string }> }
      >,
    ))
      for (const endpoint of Object.values(group.endpoints))
        if (!endpoint.path.startsWith("/api/")) stray.push(`${endpoint.method} ${endpoint.path}`)
    expect(stray).toEqual([])
  })

  test("the three remove endpoints are declared as DELETE under /api/", () => {
    const declared: Record<string, string> = {}
    for (const group of Object.values(
      Api.groups as Record<
        string,
        { readonly endpoints: Record<string, { readonly method: string; readonly path: string }> }
      >,
    ))
      for (const [name, endpoint] of Object.entries(group.endpoints))
        declared[name] = `${endpoint.method} ${endpoint.path}`
    expect(declared["agent.remove"]).toBe("DELETE /api/agent/:agentID")
    expect(declared["command.remove"]).toBe("DELETE /api/command/:name")
    expect(declared["reference.remove"]).toBe("DELETE /api/reference/:name")
  })

  test("agent.remove deletes the row AND clears a default that pointed at it", async () => {
    const handler = await registeredHandler("server.agent", "agent.remove")
    await run(
      Effect.gen(function* () {
        const store = yield* AgentConfigStore.Service
        yield* store.setLayers("reviewer", [decodeAgent({ description: "review things" })])
        yield* store.setDefault("reviewer")

        yield* handler({ params: { agentID: "reviewer" } })

        expect(Object.keys(yield* store.agents())).not.toContain("reviewer")
        expect(yield* store.getDefault()).toBeUndefined()
        // Cleared to NO row, so the jsonc/seed path can seed a default again.
        yield* store.setDefaultIfEmpty("build")
        expect(yield* store.getDefault()).toBe("build")
      }),
    )
  })

  // THE NEGATIVE CONTROL. A handler that just called `clearDefault()` unconditionally would pass
  // the test above and silently unset the user's default every time they deleted any agent.
  test("agent.remove leaves a default alone when it pointed at a DIFFERENT agent", async () => {
    const handler = await registeredHandler("server.agent", "agent.remove")
    await run(
      Effect.gen(function* () {
        const store = yield* AgentConfigStore.Service
        yield* store.setLayers("reviewer", [decodeAgent({ description: "review things" })])
        yield* store.setLayers("scribe", [decodeAgent({ description: "write things" })])
        yield* store.setDefault("scribe")

        yield* handler({ params: { agentID: "reviewer" } })

        expect(Object.keys(yield* store.agents())).toEqual(["scribe"])
        expect(yield* store.getDefault()).toBe("scribe")
      }),
    )
  })

  test("agent.remove on a name with no stored row is idempotent, not a failure", async () => {
    const handler = await registeredHandler("server.agent", "agent.remove")
    await run(
      Effect.gen(function* () {
        const store = yield* AgentConfigStore.Service
        yield* store.setDefault("build")
        yield* handler({ params: { agentID: "never-existed" } })
        expect(yield* store.isEmpty()).toBe(true)
        expect(yield* store.getDefault()).toBe("build")
      }),
    )
  })

  test("command.remove deletes the row and leaves every other command", async () => {
    const handler = await registeredHandler("server.command", "command.remove")
    await run(
      Effect.gen(function* () {
        const store = yield* CommandConfigStore.Service
        yield* store.setLayers("deploy", [decodeCommand({ template: "ship it" })])
        yield* store.setLayers("greet", [decodeCommand({ template: "hi" })])

        yield* handler({ params: { name: "deploy" } })

        expect(Object.keys(yield* store.commands())).toEqual(["greet"])
      }),
    )
  })

  test("reference.remove deletes the row and leaves every other alias", async () => {
    const handler = await registeredHandler("server.reference", "reference.remove")
    await run(
      Effect.gen(function* () {
        const store = yield* ReferenceConfigStore.Service
        yield* store.setLayers("docs", [decodeReference({ repository: "git@example.com:docs.git" })])
        yield* store.setLayers("notes", [decodeReference("../notes")])

        yield* handler({ params: { name: "docs" } })

        expect(Object.keys(yield* store.references())).toEqual(["notes"])
      }),
    )
  })
})
