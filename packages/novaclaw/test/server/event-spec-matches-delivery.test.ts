import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OpenApi } from "effect/unstable/httpapi"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { ServerEvent } from "@novaclaw/schema/server-event"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

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

  test("🔴 the gap is CLOSED: every type the bus carries is deliverable, and the wire adds only its opener", () => {
    // This test measured the GAP until 2026-09-03, and its fixture was the gap itself: a type the bus
    // published that the wire could not express. There is no such type any more, so the assertion is
    // the invariant that replaced it — the bus IS the served set — and the fixture that keeps it
    // honest is the one arm on the other side: `server.connected`, which no publisher ever puts on
    // the bus because the route synthesizes it as its first element.
    //
    // ⚠️ The gap closed in two moves, and neither was "widen the wire until the test passes": ten
    // families JOINED the served set (they were already on the bus, and the app was waiting on them),
    // and the four families nothing published — `question`, `permission`, and the two stream
    // lifecycle arms — LEFT the manifest. `event-manifest.test.ts` carries the review of both.
    // ⚠️ `Set<string>`, not the inferred narrow union: this is a membership ORACLE asked about a type
    // deliberately outside it, and a set inferred over its own members rejects that question at the
    // type level while the runtime answers it correctly. Same reasoning as `handlers/event.test.ts`.
    const onTheBus = new Set<string>(EventManifest.Definitions.map((definition) => definition.type))
    expect([...onTheBus].filter((type) => !deliverableTypes.has(type)).sort()).toEqual([])
    expect([...deliverableTypes].filter((type) => !onTheBus.has(type)).sort()).toEqual(["server.connected"])
    // …and the disposal that used to be the gap is now what it always was: the OTHER stream's
    // element, declared by the route that relays it and absent from the bus inventory entirely.
    expect(onTheBus.has(ServerEvent.Disposed.type)).toBe(false)
    expect(deliverableTypes.has(ServerEvent.Disposed.type)).toBe(false)
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
