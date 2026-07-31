import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { NovaClawHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

/**
 * The OpenAPI transform must not eat a `null` that MEANS something.
 *
 * `packages/protocol`'s HttpApi is the one contract (ruling 11) and `matchLegacyOpenApi` in
 * `httpapi/public.ts` is the only thing standing between it and the artifact every client is generated
 * from. That transform exists to delete one specific artefact — the `{type:"null"}` arm Effect adds to
 * `Schema.optional(T)` — and until 2026-07-31 it could not tell that arm apart from a real one, because
 * `Schema.NullOr(T)` emits the byte-identical `anyOf: [T, {type:"null"}]`. It read neither the enclosing
 * `required` array nor the arm count, so it stripped both.
 *
 * The cost was not cosmetic. `POST /api/session/{sessionID}/strict`, `.../feature` and
 * `.../prompt-override` each take one `Schema.NullOr` field whose own OpenAPI description says *"null
 * clears the override back to inherit"* — that is architecture.md's `undefined`-means-inherit keystone,
 * the sparse-override column of the ECS lens, reached over HTTP. The shipped SDK typed those bodies as
 * `{ strict: SessionStrictOverride }` / `{ override: string }`, so **a typed caller could not clear an
 * override at all**. Forty-nine positions in total lost their `null`.
 *
 * ⚠️ **Why this test lives here and not next to the committed artifact.** The drift test in
 * `packages/sdk/js/test/generated-drift.test.ts` compares the committed spec against a fresh run of
 * THIS SAME transform, so a null the transform eats matches a null the transform eats and the drift
 * test reports green. Catching this class needs the two documents the drift test never has at once: the
 * raw projection of the HttpApi, and the transformed one. Both are in-process here and cost no spawn.
 */

type Schema = {
  $ref?: string
  additionalProperties?: Schema | boolean
  allOf?: Schema[]
  anyOf?: Schema[]
  items?: Schema
  oneOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  type?: string
}

type Operation = {
  requestBody?: { content?: Record<string, { schema?: Schema }> }
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>
}

type Document = {
  components?: { schemas?: Record<string, Schema> }
  paths?: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>
}

const METHODS = ["get", "post", "put", "delete", "patch"] as const

/**
 * The three routes whose `200` the transform REPLACES rather than filters, and the components it
 * replaces them with.
 *
 * HttpApi has no first-class SSE response, so Effect projects these as the raw stream envelope
 * (`{id, event, data}`); `matchLegacyOpenApi` swaps in the event union that actually travels. Comparing
 * a route coordinate across that swap compares an envelope against a payload and reports the envelope's
 * own `id: string | null` as an eaten null — a false failure about a hand-written substitution that has
 * nothing to do with stripping. Excluding the response is only sound because the payload union is a
 * NAMED component with the same name in both documents, so it is walked as a root below and its nulls
 * are checked there instead. Coverage moves; it does not go away.
 */
const STREAMED_RESPONSES = new Set(["GET /event 200", "GET /global/event 200", "GET /api/event 200"])
const STREAMED_PAYLOADS = ["Event", "GlobalEvent", "V2Event"] as const

/**
 * The raw projection is captured — and deep-copied — BEFORE the transformed one is built.
 *
 * `matchLegacyOpenApi` calls `OpenApi.fromApi(NovaClawHttpApi)` itself (in
 * `fixSelfReferencingComponents`) and lifts schema objects out of the result. Snapshotting first means
 * this test compares against the protocol as authored, no matter what Effect memoizes or what the
 * transform mutates on its way through.
 */
// `as unknown as` deliberately: Effect types the projection precisely and this file only needs the
// handful of JSON-Schema keywords below, so a structural cast would couple the test to that shape.
const raw = structuredClone(OpenApi.fromApi(NovaClawHttpApi)) as unknown as Document
const published = OpenApi.fromApi(PublicApi) as unknown as Document

/** The arms of a union, with nested unions flattened — the shape `stripOptionalNull` reasons over. */
function options(schema: Schema | undefined): Schema[] | undefined {
  return (schema?.anyOf ?? schema?.oneOf)?.flatMap((item) => options(item) ?? [item])
}

/**
 * Count the `null` arms, seeing through the single-element `allOf` Effect uses to hang a constraint on
 * a union — `stripOptionalNull` unwraps that before it counts, so a check that did not would disagree
 * with the code it is guarding.
 */
function nullArms(schema: Schema | undefined): number {
  const unwrapped = schema?.allOf?.length === 1 ? { ...schema, ...schema.allOf[0], allOf: undefined } : schema
  return options(unwrapped)?.filter((item) => item.type === "null").length ?? 0
}

/**
 * Walk every route's payload and response schemas, recording a coordinate per position that carries a
 * `null`.
 *
 * `meaningfulOnly` selects the two readings the assertion needs from ONE walk, so both sides descend
 * identically and their coordinates line up:
 *
 * - `true` (the raw document) — record only where a `null` is part of the contract: a payload/response
 *   root, an array item, a record value, a property listed in `required`, or a property NOT listed but
 *   carrying **two** `null` arms (`Schema.optional(Schema.NullOr(T))`, which nests the unions).
 * - `false` (the published document) — record wherever a `null` survived, whatever the reason.
 *
 * Coordinates deliberately do not index union arms. The transform flattens and drops arms, so an index
 * would not survive it; without one, an arm's finding can be satisfied by a sibling arm. That only ever
 * makes the assertion weaker, never wrong.
 */
function nullableCoordinates(document: Document, meaningfulOnly: boolean): Set<string> {
  const found = new Set<string>()
  const schemas = document.components?.schemas ?? {}
  // Bounds the walk: recursive schemas and shared component nodes would otherwise be re-entered once
  // per path that reaches them, and the event unions are reached from a great many.
  const walked = new WeakMap<object, Set<string>>()

  function visit(schema: Schema | undefined, where: string, meaningful: boolean, refs: ReadonlySet<string>) {
    if (!schema || typeof schema !== "object") return
    if (schema.$ref) {
      const name = schema.$ref.replace("#/components/schemas/", "")
      if (refs.has(name)) return
      visit(schemas[name], where, meaningful, new Set([...refs, name]))
      return
    }
    // Keyed on the reading too, not just the coordinate: reaching one node first as "optional here"
    // and later as "required here" must not let the cheaper visit suppress the stricter one.
    const key = `${where}|${meaningful}`
    const seenHere = walked.get(schema)
    if (seenHere?.has(key)) return
    if (seenHere) seenHere.add(key)
    else walked.set(schema, new Set([key]))

    if (nullArms(schema) > 0 && (meaningful || !meaningfulOnly)) found.add(where)

    for (const arm of options(schema) ?? []) visit(arm, where, meaningful, refs)
    for (const member of schema.allOf ?? []) visit(member, where, meaningful, refs)
    if (schema.items) visit(schema.items, `${where}[]`, true, refs)
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      visit(schema.additionalProperties, `${where}{}`, true, refs)
    if (schema.properties) {
      const required = new Set(schema.required ?? [])
      for (const [key, value] of Object.entries(schema.properties))
        visit(value, `${where}.${key}`, required.has(key) || nullArms(value) > 1, refs)
    }
  }

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method]
      if (!operation) continue
      const route = `${method.toUpperCase()} ${path}`
      for (const [type, content] of Object.entries(operation.requestBody?.content ?? {}))
        visit(content.schema, `${route} body(${type})`, true, new Set())
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (STREAMED_RESPONSES.has(`${route} ${status}`)) continue
        for (const [type, content] of Object.entries(response.content ?? {}))
          visit(content.schema, `${route} ${status}(${type})`, true, new Set())
      }
    }
  }
  for (const name of STREAMED_PAYLOADS) visit(schemas[name], `component ${name}`, true, new Set([name]))
  return found
}

describe("the OpenAPI transform preserves meaningful nulls", () => {
  test("every null the HttpApi declares survives into the published document", () => {
    const contract = nullableCoordinates(raw, true)
    const surviving = nullableCoordinates(published, false)

    const eaten = [...contract].filter((coordinate) => !surviving.has(coordinate)).sort()

    expect(
      eaten,
      [
        `matchLegacyOpenApi deleted a \`null\` that packages/protocol declares, at ${eaten.length} coordinate(s).`,
        "",
        ...eaten.slice(0, 40).map((coordinate) => `  ${coordinate}`),
        eaten.length > 40 ? `  … and ${eaten.length - 40} more` : "",
        "",
        "`Schema.optional(T)` and `Schema.NullOr(T)` emit the SAME `anyOf:[T,{type:null}]`; only the",
        "enclosing `required` array (and, for `optional(NullOr(T))`, a doubled null arm) tells them apart.",
        "Fix `stripOptionalNull` in src/server/routes/instance/httpapi/public.ts — never by re-adding the",
        "field by hand downstream, which is the practice this test replaced.",
      ].join("\n"),
    ).toEqual([])

    // Guards the guard: a walker that silently stopped descending would report zero eaten nulls too.
    expect(contract.size).toBeGreaterThan(30)
  })

  test("the three per-session override endpoints can still say `null` (inherit)", () => {
    // architecture.md's keystone on the wire. Named separately from the sweep above because these are
    // the three that make the sweep worth having, and a failure here should say so in one line.
    const overrides = [
      ["/api/session/{sessionID}/strict", "strict"],
      ["/api/session/{sessionID}/feature", "enabled"],
      ["/api/session/{sessionID}/prompt-override", "override"],
    ] as const

    for (const [path, field] of overrides) {
      const body = published.paths?.[path]?.post?.requestBody?.content?.["application/json"]?.schema
      expect(body?.required, `${path} must still require \`${field}\``).toContain(field)
      expect(
        nullArms(body?.properties?.[field]),
        `POST ${path} lost \`${field}: null\` — the SDK can no longer clear this override, so a session can never fall back to inheriting it from its parent chain.`,
      ).toBe(1)
    }
  })

  test("an optional field is still narrowed to its plain type", () => {
    // The other half of the discriminator: without this, "preserve nulls" could be satisfied by not
    // stripping anything, which would change every optional field in the SDK from `T` to `T | null`.
    const info = published.components?.schemas?.["SessionV2.Info"] ?? published.components?.schemas?.SessionV2Info
    expect(info, "SessionV2.Info should exist in the published document").toBeDefined()
    const required = new Set(info?.required ?? [])
    const optional = Object.entries(info?.properties ?? {}).filter(([key]) => !required.has(key))
    expect(optional.length, "SessionV2.Info should have optional fields to check").toBeGreaterThan(0)
    const leaked = optional.filter(([, schema]) => nullArms(schema) > 0).map(([key]) => key)
    expect(leaked, "`Schema.optional` fields must not carry a null arm — absence from `required` says it").toEqual([])
  })
})
