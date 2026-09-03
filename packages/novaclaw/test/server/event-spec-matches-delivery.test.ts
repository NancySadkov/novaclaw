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

  test("the fixture is real: the bus is wider than the wire, and global.disposed is the gap", () => {
    // Nothing below means anything if the two sets were the same set all along. The gap used to be
    // ten families wide with `session.status` as its sharpest case; since 2026-09-03 the served set
    // is the bus minus the two server-lifecycle types, and `global.disposed` — which rides
    // `/global/event`, not this stream — is what is left of it.
    expect(EventManifest.Latest.size).toBeGreaterThan(deliverableTypes.size)
    const onTheBus = new Set(EventManifest.Definitions.map((definition) => definition.type))
    expect(onTheBus.has(ServerEvent.Disposed.type)).toBe(true)
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
