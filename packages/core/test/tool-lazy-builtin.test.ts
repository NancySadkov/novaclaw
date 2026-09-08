import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { ToolRegistry } from "../src/tool/registry"
import { Tool } from "../src/tool/tool"
import { Tools } from "../src/tool/tools"
import { LazyBuiltin } from "../src/tool/lazy-builtin"
import { ToolOutputStore } from "../src/tool-output-store"
import { ToolPolicyGate } from "../src/tool-policy-gate"
import { SessionSchema } from "../src/session/schema"
import { bypassedPolicyGate, toolIdentity } from "./lib/tool"

class Owner extends Context.Service<Owner, { value: string }>()("LazyBuiltinTest.Owner") {}
const metadata = {
  description: "Read the captured owner",
  input: Schema.Struct({}),
  output: Schema.String,
  sideEffect: "read" as const,
}
const definition = Tool.definition("sleepy", Tool.make({ ...metadata, execute: () => Effect.succeed("") }))
const registryLayer = AppNodeBuilder.build(ToolRegistry.node, [
  [
    ToolOutputStore.node,
    Layer.mock(ToolOutputStore.Service, {
      bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
    }),
  ],
  [ToolPolicyGate.node, bypassedPolicyGate],
])
const call = (id: string): ToolRegistry.ExecuteInput => ({
  ...toolIdentity,
  sessionID: SessionSchema.ID.make("ses_lazy"),
  call: { type: "tool-call", id, name: "sleepy", input: {} },
})

test("discovery and permission withdrawal do not load; concurrent calls share the original services and one scoped implementation", async () => {
  let imports = 0,
    acquisitions = 0,
    finalized = 0
  let shared = true
  const owner = { value: "original owner" }
  const implementation = Layer.effectDiscard(
    Effect.gen(function* () {
      const actualOwner = yield* Owner
      shared &&= actualOwner === owner
      acquisitions++
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized++
        }),
      )
      const tools = yield* Tools.Service
      yield* tools.register({
        sleepy: Tool.withDeferred(Tool.make({ ...metadata, execute: () => Effect.succeed(actualOwner.value) })),
      })
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const scope = yield* Scope.Scope
        yield* Layer.buildWithScope(
          LazyBuiltin.layer({
            definition,
            sideEffect: "read",
            load: async () => {
              imports++
              await Promise.resolve()
              return { layer: implementation }
            },
          }),
          scope,
        )
        const undisclosed = yield* registry.materialize()
        expect(undisclosed.deferred.map((s) => s.definition.name)).toEqual(["sleepy"])
        expect((yield* undisclosed.settle(call("hidden"))).result.type).toBe("error")
        const denied = yield* registry.materialize(
          [{ action: "sleepy", resource: "*", effect: "deny" }],
          undefined,
          new Set(["sleepy"]),
        )
        expect((yield* denied.settle(call("denied"))).result.type).toBe("error")
        expect(imports).toBe(0)
        const ready = yield* registry.materialize([], undefined, new Set(["sleepy"]))
        const results = yield* Effect.all(
          Array.from({ length: 12 }, (_, i) => ready.settle(call(String(i)))),
          { concurrency: "unbounded" },
        )
        expect(results.every((result) => JSON.stringify(result.result).includes("original owner"))).toBe(true)
        expect(imports).toBe(1)
        expect(acquisitions).toBe(1)
        expect(shared).toBe(true)
        expect(finalized).toBe(0)
      }).pipe(Effect.provideService(Owner, owner), Effect.provide(registryLayer)),
    ),
  )
  expect(finalized).toBe(1)
})

test("load failure is a tool result and a later call can retry without rebuilding the registry", async () => {
  let attempts = 0
  const implementation = Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      yield* tools.register({
        sleepy: Tool.withDeferred(Tool.make({ ...metadata, execute: () => Effect.succeed("recovered") })),
      })
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.buildWithScope(
          LazyBuiltin.layer({
            definition,
            sideEffect: "read",
            load: async () => {
              if (++attempts === 1) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                throw new Error("forced loader failure")
              }
              return { layer: implementation }
            },
          }),
          yield* Scope.Scope,
        )
        const registry = yield* ToolRegistry.Service
        const ready = yield* registry.materialize([], undefined, new Set(["sleepy"]))
        const failed = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) => ready.settle(call(`first-${i}`))),
          { concurrency: "unbounded" },
        )
        expect(failed.every((result) => result.result.type === "error")).toBe(true)
        expect(failed.every((result) => JSON.stringify(result.result).includes("unavailable"))).toBe(true)
        expect(attempts).toBe(1)
        expect(JSON.stringify((yield* ready.settle(call("retry"))).result)).toContain("recovered")
        expect(attempts).toBe(2)
      }).pipe(Effect.provide(registryLayer)),
    ),
  )
})

test("the same implementation module captures each location's owner under a shared layer memo map", async () => {
  const owners: unknown[] = []
  let finalized = 0
  const implementation = Layer.effectDiscard(
    Effect.gen(function* () {
      const owner = yield* Owner
      owners.push(owner)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized++
        }),
      )
      const tools = yield* Tools.Service
      yield* tools.register({
        sleepy: Tool.withDeferred(Tool.make({ ...metadata, execute: () => Effect.succeed(owner.value) })),
      })
    }),
  )
  const registrations = LazyBuiltin.layer({
    definition,
    sideEffect: "read",
    load: async () => ({ layer: implementation }),
  })
  const first = { value: "first location" },
    second = { value: "second location" }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const owner of [first, second]) {
          let proxy: Tool.AnyTool | undefined
          const capture = Tools.Service.of({
            register: (entries) =>
              Effect.sync(() => {
                proxy = entries.sleepy
              }),
          })
          yield* Layer.buildWithScope(Layer.fresh(registrations), yield* Scope.Scope).pipe(
            Effect.provideService(Owner, owner),
            Effect.provideService(Tools.Service, capture),
          )
          const result = yield* Tool.settle(proxy!, call(owner.value).call, {
            ...toolIdentity,
            toolCallID: owner.value,
            sessionID: SessionSchema.ID.make("ses_lazy"),
          })
          expect(JSON.stringify(result)).toContain(owner.value)
        }
        expect(owners).toEqual([first, second])
        expect(owners[0]).toBe(first)
        expect(owners[1]).toBe(second)
        expect(finalized).toBe(0)
      }).pipe(Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe())),
    ),
  )
  expect(finalized).toBe(2)
})

test("stale schema or side-effect metadata cannot execute an implementation", async () => {
  let executed = false
  const implementation = Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      yield* tools.register({
        sleepy: Tool.withDeferred(
          Tool.make({
            ...metadata,
            sideEffect: "non-idempotent",
            execute: () => {
              executed = true
              return Effect.succeed("unsafe")
            },
          }),
        ),
      })
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.buildWithScope(
          LazyBuiltin.layer({ definition, sideEffect: "read", load: async () => ({ layer: implementation }) }),
          yield* Scope.Scope,
        )
        const registry = yield* ToolRegistry.Service
        const ready = yield* registry.materialize([], undefined, new Set(["sleepy"]))
        expect((yield* ready.settle(call("stale"))).result.type).toBe("error")
        expect(executed).toBe(false)
      }).pipe(Effect.provide(registryLayer)),
    ),
  )
})
