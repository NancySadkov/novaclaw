import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"

class Value extends Context.Service<Value, { readonly value: string }>()("test/LayerNodeValue") {}
class Greeting extends Context.Service<Greeting, { readonly value: string }>()("test/LayerNodeGreeting") {}
class Left extends Context.Service<Left, { readonly value: string }>()("test/LayerNodeLeft") {}
class Right extends Context.Service<Right, { readonly value: string }>()("test/LayerNodeRight") {}
class Database extends Context.Service<Database, { readonly name: string }>()("test/GraphDatabase") {}
class Users extends Context.Service<Users, { readonly list: Effect.Effect<string[]> }>()("test/GraphUsers") {}
class App extends Context.Service<App, { readonly run: Effect.Effect<string[]> }>()("test/GraphApp") {}

const tags = LayerNode.tags({ app: [] })
const make = tags.make("app")
const build = <A, E>(root: LayerNode.Node<A, E, any>, replacements?: readonly LayerNode.Replacement[]) =>
  LayerNode.compile(root, replacements) as Layer.Layer<A, E>
const valueLayer = Layer.succeed(Value, Value.of({ value: "production" }))
const greetingLayer = Layer.effect(
  Greeting,
  Effect.map(Value, (value) => Greeting.of({ value: `hello ${value.value}` })),
)
const value = make({ service: Value, layer: valueLayer, deps: [] })
const greeting = make({ service: Greeting, layer: greetingLayer, deps: [value] })

describe("layer node", () => {
  test("builds an untagged graph", async () => {
    const value = LayerNode.make({ service: Value, layer: valueLayer, deps: [] })
    const greeting = LayerNode.make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(LayerNode.compile(LayerNode.group([greeting]))),
    )
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("builds a dependency graph", async () => {
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(build(LayerNode.group([greeting]))))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("exposes roots but hides transitive dependencies", () => {
    const layer = build(LayerNode.group([greeting]))
    const check: Layer.Layer<Greeting> = layer
    void check
  })

  test("preserves branch-specific implementations across roots", async () => {
    const firstValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "first" })), deps: [] })
    const secondValue = make({ service: Value, layer: Layer.succeed(Value, Value.of({ value: "second" })), deps: [] })
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [firstValue] })
    const right = make({ service: Right, layer: rightLayer, deps: [secondValue] })
    const layer = build(LayerNode.group([left, right]))
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["first", "second"])
  })

  test("requires unbound nodes to be replaced before compilation", async () => {
    const unbound = LayerNode.unbound(Value, tags.values.app)
    const greeting = make({ service: Greeting, layer: greetingLayer, deps: [unbound] })
    const tree = LayerNode.group([greeting])
    expect(() => LayerNode.compile(tree)).toThrow("Unbound layer node: test/LayerNodeValue")
    const layer = LayerNode.compile(tree, [[unbound, value]]) as Layer.Layer<Greeting>
    const program = Effect.map(Greeting, (item) => item.value).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toBe("hello production")
  })

  test("replaces a node with a closed layer", async () => {
    const replacement = Layer.succeed(Value, Value.of({ value: "simulation" }))
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([greeting]), [[value, replacement]])),
    )
    expect(await Effect.runPromise(program)).toBe("hello simulation")
  })

  test("replaces every use of the same layer", async () => {
    const leftLayer = Layer.effect(
      Left,
      Effect.map(Value, (item) => Left.of({ value: item.value })),
    )
    const rightLayer = Layer.effect(
      Right,
      Effect.map(Value, (item) => Right.of({ value: item.value })),
    )
    const left = make({ service: Left, layer: leftLayer, deps: [value] })
    const right = make({ service: Right, layer: rightLayer, deps: [value] })
    const replacement = Layer.succeed(Value, Value.of({ value: "replaced" }))
    const layer = build(LayerNode.group([left, right]), [[value, replacement]])
    const program = Effect.gen(function* () {
      return [(yield* Left).value, (yield* Right).value]
    }).pipe(Effect.provide(layer))
    expect(await Effect.runPromise(program)).toEqual(["replaced", "replaced"])
  })

  test("does not acquire an unused replacement", async () => {
    let acquisitions = 0
    const other = make({ service: Left, layer: Layer.succeed(Left, Left.of({ value: "other" })), deps: [] })
    const replacement = Layer.effect(
      Left,
      Effect.sync(() => {
        acquisitions++
        return Left.of({ value: "replacement" })
      }),
    )
    await Effect.runPromise(
      Effect.map(Greeting, (item) => item.value).pipe(
        Effect.provide(build(LayerNode.group([greeting]), [[other, replacement]])),
      ),
    )
    expect(acquisitions).toBe(0)
  })

  test("replaces a node without acquiring its dependencies", async () => {
    let acquisitions = 0
    const dependencyLayer = Layer.effect(
      Value,
      Effect.sync(() => {
        acquisitions++
        return Value.of({ value: "dependency" })
      }),
    )
    const dependency = make({ service: Value, layer: dependencyLayer, deps: [] })
    const original = make({ service: Greeting, layer: greetingLayer, deps: [dependency] })
    const replacement = make({
      service: Greeting,
      layer: Layer.succeed(Greeting, Greeting.of({ value: "replacement" })),
      deps: [],
    })

    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(build(LayerNode.group([original]), [[original, replacement]])),
    )

    expect(await Effect.runPromise(program)).toBe("replacement")
    expect(acquisitions).toBe(0)
  })

  test("applies later replacements inside earlier replacement nodes", async () => {
    const original = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const replacement = make({ service: Greeting, layer: greetingLayer, deps: [value] })
    const program = Effect.map(Greeting, (item) => item.value).pipe(
      Effect.provide(
        build(LayerNode.group([original]), [
          [original, replacement],
          [value, Layer.succeed(Value, Value.of({ value: "replacement dependency" }))],
        ]),
      ),
    )

    expect(await Effect.runPromise(program)).toBe("hello replacement dependency")
  })

  test("hoists and compiles tagged graphs", async () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(
        Users,
        Effect.gen(function* () {
          const db = yield* Database
          return Users.of({ list: Effect.succeed([db.name]) })
        }),
      ),
      deps: [database],
    })
    const app = location({
      service: App,
      layer: Layer.effect(
        App,
        Effect.gen(function* () {
          const service = yield* Users
          return App.of({ run: service.list })
        }),
      ),
      deps: [users],
    })

    const result = LayerNode.hoist(LayerNode.group([app]), tags.values.global)
    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
    expect(result.hoisted.dependencies).toEqual([database])

    const layer = LayerNode.compile(result.node).pipe(
      Layer.provide(LayerNode.compile(result.hoisted)),
    ) as unknown as Layer.Layer<App>
    const program = Effect.gen(function* () {
      return yield* (yield* App).run
    }).pipe(Effect.provide(layer))

    expect(await Effect.runPromise(program)).toEqual(["Alice"])
  })

  test("rejects conflicting hoisted implementations", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const first = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "first" })),
      deps: [],
    })
    const second = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "second" })),
      deps: [],
    })
    const left = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [first],
    })
    const right = location({
      service: App,
      layer: Layer.effect(App, Effect.as(Database, App.of({ run: Effect.succeed([]) }))),
      deps: [second],
    })

    expect(() => LayerNode.hoist(LayerNode.group([left, right]), tags.values.global)).toThrow(
      "Tag global has conflicting implementations for test/GraphDatabase",
    )
  })

  test("treats dependency groups as transparent while hoisting", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
      deps: [],
    })
    const users = location({
      service: Users,
      layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
      deps: [LayerNode.group([database])],
    })
    const result = LayerNode.hoist(LayerNode.group([users]), tags.values.global)

    expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
      kind: "group",
      dependencies: [],
    })
  })

  // The bug this pins (found 2026-07-28, fixed 2026-07-29): `hoist` used to lift a hoisted node out
  // BY REFERENCE with its dependency array untouched (`hoisted.set(node.name, node); return
  // group([])`), so a replacement was honoured for the hoisted node ITSELF and for the location half
  // but NOT inside another hoisted node's dependency subtree. `location-services.ts` compiles the
  // hoisted half with no replacements, so on the real graph 16 of the 35 hoisted globals — every
  // config store, Event, Credential, SessionStore, bash-jobs-recovery, WebSearch — still pointed at
  // the original `Database.node` when a caller replaced it: a test's mock AND a real second SQLite
  // connection alive in one process, with the tested code reading whichever one it happened to
  // depend on.
  //
  // ⚠️ The negative control is the FIRST assertion, not an afterthought: without a replacement the
  // same reader must observe "real" through `users`. That is what proves this test can see the leak
  // at all — an assertion that only ever reads "stub" would pass just as happily against a graph
  // where `users` was never wired to `Database`.
  test("applies replacements inside hoisted dependency subtrees", async () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    let realBuilds = 0
    const database = global({
      service: Database,
      layer: Layer.effect(
        Database,
        Effect.sync(() => {
          realBuilds++
          return Database.of({ name: "real" })
        }),
      ),
      deps: [],
    })
    const users = global({
      service: Users,
      layer: Layer.effect(
        Users,
        Effect.map(Database, (item) => Users.of({ list: Effect.succeed([item.name]) })),
      ),
      deps: [database],
    })
    const app = location({
      service: App,
      layer: Layer.effect(
        App,
        Effect.map(Users, (item) => App.of({ run: item.list })),
      ),
      // Depends on both, mirroring the real graph where `Database` is reachable from a location node
      // directly as well as through the other globals — that is what puts it in the hoisted set.
      deps: [users, database],
    })
    const replacements = [[database, Layer.succeed(Database, Database.of({ name: "stub" }))]] as const
    const read = (layer: Layer.Layer<Database | Users, never, never>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const seenByUsers = yield* Effect.flatMap(Users, (item) => item.list)
          return { top: (yield* Database).name, seenByUsers }
        }).pipe(Effect.scoped, Effect.provide(layer)),
      )

    // NEGATIVE CONTROL — no replacement, so both readers must see the real service, and the reader
    // through `users` must genuinely reach it.
    const unreplaced = LayerNode.hoist(LayerNode.group([app]), tags.values.global)
    expect(await read(LayerNode.compile(unreplaced.hoisted) as Layer.Layer<Database | Users>)).toEqual({
      top: "real",
      seenByUsers: ["real"],
    })
    expect(realBuilds).toBe(1)

    // The fix: `hoist` rewrites the hoisted subtrees too, so the caller compiles the half it was
    // handed and gets the replacement everywhere. The real layer is never constructed.
    realBuilds = 0
    const { hoisted } = LayerNode.hoist(LayerNode.group([app]), tags.values.global, replacements)
    expect(await read(LayerNode.compile(hoisted) as Layer.Layer<Database | Users>)).toEqual({
      top: "stub",
      seenByUsers: ["stub"],
    })
    expect(realBuilds).toBe(0)

    // …and re-applying the same replacements at `compile` is idempotent, not a second substitution:
    // callers that already pass them (or that stop) get the same graph either way.
    expect(await read(LayerNode.compile(hoisted, replacements) as Layer.Layer<Database | Users>)).toEqual({
      top: "stub",
      seenByUsers: ["stub"],
    })
    expect(realBuilds).toBe(0)
  })

  test("keeps the hoisted half free of the replaced node, and shares a rewritten subtree", () => {
    const tags = LayerNode.tags({ location: ["global"], global: [] })
    const global = tags.make("global")
    const location = tags.make("location")
    const database = global({
      service: Database,
      layer: Layer.succeed(Database, Database.of({ name: "real" })),
      deps: [],
    })
    const users = global({
      service: Users,
      layer: Layer.effect(
        Users,
        Effect.map(Database, (item) => Users.of({ list: Effect.succeed([item.name]) })),
      ),
      deps: [database],
    })
    const second = global({
      service: Left,
      layer: Layer.effect(
        Left,
        Effect.map(Users, (item) => Left.of({ value: String(item.list) })),
      ),
      deps: [users],
    })
    const app = location({
      service: App,
      layer: Layer.effect(App, Effect.as(Left, App.of({ run: Effect.succeed([]) }))),
      deps: [second, users, database],
    })

    const stub = Layer.succeed(Database, Database.of({ name: "stub" }))
    const { hoisted } = LayerNode.hoist(LayerNode.group([app]), tags.values.global, [[database, stub]])

    const reached = new Set<{ readonly dependencies: readonly any[] }>()
    const stack: any[] = [hoisted]
    while (stack.length > 0) {
      const item = stack.pop()
      if (reached.has(item)) continue
      reached.add(item)
      for (const dependency of item.dependencies) stack.push(dependency)
    }
    // The original node object must not survive anywhere in the shared half.
    expect(reached.has(database as never)).toBe(false)
    // `users` is reachable both as a hoisted root and through `second`; it must be ONE object, or
    // `compile` caches it twice and the graph carries two wrappers for one service.
    expect([...reached].filter((item) => (item as { name?: string }).name === Users.key)).toHaveLength(1)
  })
})
