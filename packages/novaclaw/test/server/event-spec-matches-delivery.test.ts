import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Stream } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import type { EventV2 } from "@novaclaw/core/event"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { boundedSubscription } from "../../src/server/routes/instance/httpapi/handlers/event"

/**
 * Two properties of the event streams this server publishes, both of which were false.
 *
 * 1. **`GET /api/event`'s published contract must be the set the route can actually deliver.** The
 *    instance package used to declare its own copy of the `/api/*` surface, widened to the whole bus
 *    manifest, while the served handler narrows to `ServerDefinitions ∪ server.connected`. Twenty
 *    arms were promised and silently never sent — no error, no log, nothing a client could observe
 *    except waiting forever for an event that is dropped by design.
 * 2. **`GET /event`'s subscriber queue must be bounded, and filtered before the bound.** It was
 *    `Queue.unbounded` with the location predicate applied one stage LATER, so every subscriber
 *    accumulated every location's events with no limit and discarded almost all of them.
 */

type OpenApiSchema = {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly enum?: readonly unknown[]
  readonly properties?: Record<string, OpenApiSchema>
}
type OpenApiSpec = {
  readonly paths: Record<string, { readonly get?: { readonly responses?: Record<string, unknown> } }>
  readonly components: { readonly schemas: Record<string, OpenApiSchema> }
}

/** The app repo root, so the served handler can be read as text. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")

/**
 * Every event type the SHIPPED spec says `GET /api/event` can carry, read out of the generated
 * OpenAPI document rather than out of the constant the document is built from.
 *
 * ⚠️ An unresolvable arm is a FAILURE, not a skip. Reading `properties.type.enum[0]` through a
 * `$ref` is exactly the kind of extraction that returns `undefined` for every arm after a generator
 * change and leaves the comparison below passing on two empty sets.
 */
function specEventTypes(): ReadonlySet<string> {
  const spec = OpenApi.fromApi(PublicApi) as unknown as OpenApiSpec
  const schemas = spec.components.schemas
  const arms = schemas.V2Event?.anyOf
  if (arms === undefined || arms.length === 0) throw new Error("the spec has no V2Event union to compare")
  return new Set(
    arms.map((arm) => {
      const resolved = arm.$ref === undefined ? arm : schemas[arm.$ref.slice(arm.$ref.lastIndexOf("/") + 1)]
      const literal = resolved?.properties?.type?.enum?.[0]
      if (typeof literal !== "string") throw new Error(`a V2Event arm carries no type literal: ${JSON.stringify(arm)}`)
      return literal
    }),
  )
}

/**
 * The types the served handler will emit.
 *
 * This mirrors `packages/server/src/handlers/event.ts`, whose `wireTypes` set is what actually
 * decides delivery; the behavioural proof that it drops everything else without killing the stream
 * is that file's own sibling test. {@link test} below pins the mirror to the original, so widening
 * the handler's set fails HERE rather than quietly re-opening the gap this file exists to close.
 */
const deliverableTypes: ReadonlySet<string> = new Set([
  "server.connected",
  ...EventManifest.ServerDefinitions.map((definition) => definition.type),
])

const HANDLER = "packages/server/src/handlers/event.ts"

describe("the /api/event contract equals what the route can deliver", () => {
  test("the mirror is anchored: the handler still derives its wire set from ServerDefinitions", () => {
    const source = fs.readFileSync(path.join(ROOT, HANDLER), "utf8")
    const declaration = source
      .split(/\r?\n/)
      .find((line) => line.includes("const wireTypes") && line.includes("new Set"))
    expect(declaration).toBeDefined()
    expect(declaration).toContain("EventManifest.ServerDefinitions")
    expect(declaration).toContain('"server.connected"')
  })

  test("the fixture is real: the bus is wider than the wire, and session.status is the gap", () => {
    // Nothing below means anything if the two sets were the same set all along.
    expect(EventManifest.Latest.size).toBeGreaterThan(deliverableTypes.size)
    // `session.status` is the sharpest case in the gap: the session worker WHITELISTS it past the
    // host-manifest check (`session-worker/services.ts`, `session-worker/event-bridge.ts`) so it
    // reaches the host bus, and the public wire still cannot express it.
    const onTheBus = new Set(EventManifest.Definitions.map((definition) => definition.type))
    expect(onTheBus.has(SessionStatusEvent.Status.type)).toBe(true)
    expect(deliverableTypes.has(SessionStatusEvent.Status.type)).toBe(false)
  })

  test("🔴 the spec promises exactly the arms the handler emits — no more", () => {
    const declared = specEventTypes()

    // The whole defect, as one assertion: `[...declared].filter(t => !deliverable.has(t))` used to
    // be twenty types long.
    expect([...declared].filter((type) => !deliverableTypes.has(type)).sort()).toEqual([])
    expect([...deliverableTypes].filter((type) => !declared.has(type)).sort()).toEqual([])
    expect(declared.size).toBe(deliverableTypes.size)
  })
})

type Listener = (event: EventV2.Payload) => Effect.Effect<void>

/**
 * A bus that is nothing but its listener list.
 *
 * `boundedSubscription`'s entire contract is what it does between `events.listen` and its queue, so
 * a stub that can deliver an event with a chosen `location` exercises it exactly, and a capacity of
 * four reaches the bound in twenty publishes instead of a thousand.
 */
function fakeBus() {
  const listeners = new Set<Listener>()
  const events = {
    listen: (listener: Listener) =>
      Effect.sync(() => {
        listeners.add(listener)
        return Effect.sync(() => {
          listeners.delete(listener)
        })
      }),
  } as unknown as EventV2.Interface
  const publish = (directory: string, id: string) =>
    Effect.forEach(
      [...listeners],
      (listener) => listener({ id, type: "probe.event", data: {}, location: { directory } } as EventV2.Payload),
      { discard: true },
    )
  return { events, publish }
}

const MINE = "/workspace/mine"
const THEIRS = "/workspace/theirs"

describe("the /event subscription is bounded, and filtered at the source", () => {
  test("🔴 a neighbour's traffic far past the bound cannot evict or disconnect this subscriber", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const { events, publish } = fakeBus()
        const stream = yield* boundedSubscription(events, (event) => event.location?.directory === MINE, 4)

        // Twelve times the capacity, all for a directory this subscriber did not ask for. Filtered
        // AFTER the queue these fill it, fail it, and the matching event below never arrives.
        for (let index = 0; index < 50; index++) yield* publish(THEIRS, `evt_theirs_${index}`)
        yield* publish(MINE, "evt_mine")

        const frames = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        return Array.from(frames).map((event) => event.id)
      }).pipe(Effect.scoped),
    )

    // PRESENCE and ABSENCE in the same run: the stream survived, and it carries only what it matched.
    expect(seen).toEqual(["evt_mine"])
  })

  test("🔴 a subscriber that stops reading is disconnected, not buffered without limit", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { events, publish } = fakeBus()
        const stream = yield* boundedSubscription(events, () => true, 4)

        // Nobody is draining, so this is the stalled client. Unbounded, the queue simply grows.
        for (let index = 0; index < 20; index++) yield* publish(MINE, `evt_${index}`)

        return yield* stream.pipe(
          Stream.runDrain,
          Effect.matchEffect({
            onFailure: (error: { readonly _tag: string }) => Effect.succeed(error._tag),
            onSuccess: () => Effect.succeed("ended cleanly"),
          }),
          // An unbounded queue neither fails nor ends: it would hang here rather than report.
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("still growing") }),
        )
      }).pipe(Effect.scoped),
    )

    expect(outcome).toBe("EventV2.SubscriberOverflow")
  }, 10_000)
})
