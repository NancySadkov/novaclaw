import { describe, expect, test } from "bun:test"
import path from "path"

// The SDK's two committed artifacts are GENERATED, and until 2026-07-28 nothing asserted they still
// matched their source. They silently went five days stale: `packages/sdk/openapi.json` was last
// regenerated 2026-07-23, and by the time an optional `sourceUri` was added to
// `packages/schema/src/prompt.ts` the committed spec was already missing 9 routes (calendar, recipe,
// session pending/export-markdown), 10 schemas and 3 harness-feature enum members. Ruling 1: an
// invariant whose violation compiles green ships with a mechanical check, or it does not exist.
//
// The chain has two hops and they are checked differently, because they cost differently:
//
//   packages/protocol  --(bun dev generate)-->  packages/sdk/openapi.json     hop 1 — 3.5 s, byte-exact
//   packages/sdk/openapi.json  --(@hey-api)-->  src/v2/gen/**                 hop 2 — minutes, structural here
//
// Hop 1 is re-run for real on every gate run: `bun dev generate` is a pure in-process read of
// `Server.openapi()` (no network, no database write), it is deterministic, and it is redirected to a
// TEMP file so a test run never mutates the working tree.
//
// Hop 2 cannot be re-run for real in the default tier: `script/build.ts` sets `output.clean: true`,
// so the generator EMPTIES `src/v2/gen` before writing, and it then runs prettier and `tsc`. A test
// that wipes sixteen tracked files mid-run and costs minutes does not belong in a tier the owner has
// capped at five minutes. `bun run --cwd packages/sdk/js check:generated` is the byte-exact version,
// for a human before a release. What runs here instead is the structural half that needs no
// generator: every route the spec declares must be reachable from the typed client, and the typed
// client must expose no route the spec does not declare.
//
// Whoever fixes a failure here: `bun run --cwd packages/sdk/js regen` and
// `bun script/generate.ts` now reach the same root-aware pipeline. It refreshes the committed spec
// BEFORE generating the client, then formats only the generated contract artifacts.

const root = path.resolve(import.meta.dir, "../../../..")
const specPath = path.join(root, "packages/sdk/openapi.json")
const genDir = path.join(root, "packages/sdk/js/src/v2/gen")

const REGEN = "bun run --cwd packages/sdk/js regen"

type Document = {
  paths: Record<string, Record<string, { operationId?: string } | undefined>>
  components: { schemas: Record<string, unknown> }
}

const METHODS = ["get", "post", "put", "delete", "patch"] as const

/**
 * ⚠️ **What the two hops above CANNOT see, and why the checks below exist.**
 *
 * Hop 1 re-runs the same transform on both sides of its comparison. Anything the transform does wrong
 * it does wrong identically to the committed file and to the fresh one, so a **defect in the transform
 * reads as "no drift"** — the check is a staleness detector, never a correctness one. That blind spot
 * shipped a real bug: `stripOptionalNull` deleted the `null` from 49 positions that genuinely have one,
 * including the three per-session override endpoints whose contract is *"null clears the override back
 * to inherit"*, and hop 1 was green throughout. The `null`-preservation invariant itself is asserted
 * where the transform lives (`packages/novaclaw/test/v2/openapi-nullability.test.ts`, which has the raw
 * projection to compare against); what is asserted **here** is the other end of the chain — that the
 * artifacts actually committed still carry it.
 *
 * Hop 2 compares ROUTES, so it is blind to **schema** drift. Measured 2026-07-31: the committed
 * `openapi.json` declared `ResourcePressure`, `MessengerSourceAccess` and `MessengerSourceLabel` while
 * the committed `types.gen.ts` had never heard of them — three schemas stale, both hops green. The
 * third check below closes that.
 */

type Schema = {
  anyOf?: Schema[]
  oneOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  type?: string
}

/** The same file as `Document`, read for its request-body schemas rather than its route names. */
type SchemaDocument = {
  paths: Record<
    string,
    Partial<Record<(typeof METHODS)[number], { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>
  >
  components: { schemas: Record<string, unknown> }
}

/**
 * Every request-body field the wire contract lets a caller send as `null`, by name.
 *
 * Four of these seven are the point of the ledger. `PATCH /api/session/{sessionID}`'s `archived` and
 * the three `POST /api/session/{sessionID}/…` overrides are `Schema.NullOr`, and `null` is the value
 * that CLEARS the override so the session inherits from its parent chain — architecture.md's keystone,
 * reachable over HTTP. Until 2026-07-31 all four were typed non-nullable in the generated client and a
 * typed caller simply could not express *inherit*.
 *
 * ⚠️ **A shrinking list is the alarm.** An entry disappears legitimately only when the protocol stops
 * declaring the field nullable — in which case say which one and why in the same commit. An entry
 * disappearing on its own means the transform has started eating nulls again.
 */
const NULLABLE_REQUEST_FIELDS = [
  "POST /experimental/workspace branch (optional)",
  "POST /experimental/workspace extra (optional)",
  "POST /experimental/workspace/warp id",
  "PATCH /api/session/{sessionID} archived (optional)",
  "POST /api/session/{sessionID}/strict strict",
  "POST /api/session/{sessionID}/feature enabled",
  "POST /api/session/{sessionID}/prompt-override override",
] as const

/**
 * A floor, not a pin, over the WHOLE document — request bodies, responses and components alike.
 *
 * 41 required-and-nullable properties on 2026-07-31, up from 0 before the transform was fixed. The
 * ledger above names the seven that carry semantics a human can check; this number catches the case
 * the ledger cannot — a regression that eats nulls everywhere EXCEPT the seven pinned by name.
 */
const NULLABLE_REQUIRED_FLOOR = 41

/** The arms of a union with nested unions flattened, matching how the transform reasons about them. */
function unionOptions(schema: Schema | undefined): Schema[] | undefined {
  return (schema?.anyOf ?? schema?.oneOf)?.flatMap((item) => unionOptions(item) ?? [item])
}

function isNullable(schema: Schema | undefined): boolean {
  return !!unionOptions(schema)?.some((item) => item.type === "null")
}

/** The body of `export type <name> = …`, up to the next top-level `export`. */
function exportedType(source: string, name: string): string | undefined {
  const start = source.indexOf(`export type ${name} = `)
  if (start < 0) return undefined
  const end = source.indexOf("\nexport ", start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}

/**
 * A HANG backstop for the one test that spawns a process, not a budget.
 *
 * `bun dev generate` measured 3.5 s warm on 2026-07-28, but the suite-wide 15 s per-test default is
 * thin for a cold module graph on a loaded box, and a wall-clock kill is indistinguishable from a
 * real failure in the summary. The sdk-js unit's own wall-clock kill in `script/test.ts` still bounds
 * this file, so raising it here weakens nothing.
 */
const GENERATE_TIMEOUT_MS = 60_000

/** A compact, readable account of HOW two spec documents differ — a 2000-line diff helps nobody. */
function describeDrift(committed: Document, fresh: Document): string {
  const lines: string[] = []
  const report = (label: string, before: string[], after: string[]) => {
    const added = after.filter((name) => !before.includes(name))
    const removed = before.filter((name) => !after.includes(name))
    for (const name of added) lines.push(`  + ${label} ${name} (in the protocol, missing from the committed spec)`)
    for (const name of removed) lines.push(`  - ${label} ${name} (in the committed spec, gone from the protocol)`)
  }
  report("path", Object.keys(committed.paths), Object.keys(fresh.paths))
  report("schema", Object.keys(committed.components.schemas), Object.keys(fresh.components.schemas))
  for (const name of Object.keys(fresh.components.schemas)) {
    if (!(name in committed.components.schemas)) continue
    const before = JSON.stringify(committed.components.schemas[name])
    const after = JSON.stringify(fresh.components.schemas[name])
    if (before !== after) lines.push(`  ~ schema ${name} changed shape`)
  }
  for (const name of Object.keys(fresh.paths)) {
    if (!(name in committed.paths)) continue
    if (JSON.stringify(committed.paths[name]) !== JSON.stringify(fresh.paths[name]))
      lines.push(`  ~ path ${name} changed shape`)
  }
  return lines.length > 0 ? lines.join("\n") : "  (no structural difference — formatting or key order only)"
}

describe("the SDK's generated artifacts", () => {
  test(
    "openapi.json is what packages/protocol generates today",
    async () => {
      const child = Bun.spawn(["bun", "run", "dev", "generate"], {
        cwd: path.join(root, "packages/novaclaw"),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [fresh, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode, `\`bun dev generate\` failed:\n${stderr}`).toBe(0)
      expect(fresh.length, `\`bun dev generate\` produced no document:\n${stderr}`).toBeGreaterThan(1000)

      const committed = await Bun.file(specPath).text()
      if (fresh === committed) return

      // Not `expect(fresh).toBe(committed)` — that prints a 1.1 MB pair of strings.
      const summary = describeDrift(JSON.parse(committed) as Document, JSON.parse(fresh) as Document)
      throw new Error(
        [
          "packages/sdk/openapi.json is STALE — the HttpApi in packages/protocol no longer projects to it.",
          "",
          summary,
          "",
          `Fix:  ${REGEN}`,
        ].join("\n"),
      )
    },
    GENERATE_TIMEOUT_MS,
  )

  test("the typed client exposes exactly the routes the spec declares", async () => {
    const document = (await Bun.file(specPath).json()) as Document
    const sdk = await Bun.file(path.join(genDir, "sdk.gen.ts")).text()

    // @hey-api emits every operation as `.<method><generics>({ url: "<path>", ... })`, with the path
    // VERBATIM — no name transformation, which is what makes this assertion sound. Operation *ids*
    // are not usable for this: all 212 are rewritten into container/method names.
    const emitted = new Set<string>()
    // ⚠️ `\(\s*\{`, not `\(\{`: prettier breaks the call across lines whenever the generic list is
    // long (`switchType`, `credentialRemove`, …), and a tighter regex silently under-reports.
    for (const match of sdk.matchAll(
      /\.(get|post|put|delete|patch)<[\s\S]{0,400}?>\(\s*\{[\s\S]{0,400}?url: "([^"]+)"/g,
    ))
      emitted.add(`${match[1]!.toUpperCase()} ${match[2]!}`)

    const declared = new Set<string>()
    for (const [route, item] of Object.entries(document.paths))
      for (const method of METHODS) if (item[method]) declared.add(`${method.toUpperCase()} ${route}`)

    const missing = [...declared].filter((operation) => !emitted.has(operation)).sort()
    const extra = [...emitted].filter((operation) => !declared.has(operation)).sort()

    expect(
      { missing, extra },
      [
        "src/v2/gen/sdk.gen.ts does not match packages/sdk/openapi.json.",
        `  missing from the client: ${missing.join(", ") || "none"}`,
        `  present only in the client: ${extra.join(", ") || "none"}`,
        `Fix:  ${REGEN}`,
      ].join("\n"),
    ).toEqual({ missing: [], extra: [] })
    // Guards the guard: a regex that silently stopped matching would make `missing` empty too.
    expect(declared.size).toBeGreaterThan(200)
    expect(emitted.size).toBe(declared.size)
  })

  test("the committed spec still lets callers send the nulls the contract defines", async () => {
    const document = (await Bun.file(specPath).json()) as SchemaDocument

    const nullable: string[] = []
    let requiredAndNullable = 0
    for (const [route, item] of Object.entries(document.paths)) {
      for (const method of METHODS) {
        const schema = item[method]?.requestBody?.content?.["application/json"]?.schema
        if (!schema?.properties) continue
        const required = new Set(schema.required ?? [])
        for (const [field, property] of Object.entries(schema.properties))
          if (isNullable(property))
            nullable.push(`${method.toUpperCase()} ${route} ${field}${required.has(field) ? "" : " (optional)"}`)
      }
    }

    // The whole-document sweep, components included — see NULLABLE_REQUIRED_FLOOR.
    const walked = new WeakSet<object>()
    const count = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(count)
      if (walked.has(node)) return
      walked.add(node)
      const schema = node as Schema
      if (schema.properties) {
        const required = new Set(schema.required ?? [])
        for (const [field, property] of Object.entries(schema.properties))
          if (required.has(field) && isNullable(property)) requiredAndNullable++
      }
      for (const value of Object.values(node)) count(value)
    }
    count(document.paths)
    count(document.components.schemas)

    expect(
      nullable.sort(),
      [
        "packages/sdk/openapi.json no longer offers `null` on every request-body field the protocol",
        "declares as `Schema.NullOr`. On the three per-session override routes `null` is what CLEARS the",
        "override so the session inherits from its parent chain — dropping it makes `inherit` unsendable.",
        `Fix:  ${REGEN}  (after fixing \`stripOptionalNull\` in packages/novaclaw/…/httpapi/public.ts)`,
      ].join("\n"),
    ).toEqual([...NULLABLE_REQUEST_FIELDS].sort())

    expect(
      requiredAndNullable,
      `only ${requiredAndNullable} required-and-nullable properties remain in the committed spec (floor ${NULLABLE_REQUIRED_FLOOR}) — the transform is eating nulls again.`,
    ).toBeGreaterThanOrEqual(NULLABLE_REQUIRED_FLOOR)
  })

  test("the typed client carries those nulls into TypeScript", async () => {
    // The end of the chain, and the only thing an application actually compiles against. A spec that
    // says `null` and a `types.gen.ts` that does not means the regen never ran.
    const types = await Bun.file(path.join(genDir, "types.gen.ts")).text()
    const expected = [
      ["V2SessionSwitchStrictData", "strict: SessionStrictOverride | null"],
      ["V2SessionSwitchFeatureData", "enabled: boolean | null"],
      ["V2SessionSwitchPromptOverrideData", "override: string | null"],
      ["V2SessionUpdateData", "archived?: number | null"],
    ] as const

    for (const [name, member] of expected) {
      const body = exportedType(types, name)
      expect(body, `src/v2/gen/types.gen.ts no longer exports ${name}`).toBeDefined()
      expect(
        body,
        `${name} lost \`${member}\` — a typed caller can no longer clear this override.\nFix:  ${REGEN}`,
      ).toContain(member)
    }
  })

  test("every schema the spec declares reaches the typed client", async () => {
    // Hop 2's route check is blind to schemas: on 2026-07-31 the committed spec carried three schemas
    // the committed client had never been regenerated for, and both existing checks were green.
    //
    // @hey-api rewrites 30 of 447 schema names — dots, dashes and underscores are collapsed
    // (`session.status`, `Models-devRefreshed`, `effect_HttpApiError_BadRequest`) in ways this test
    // would have to reimplement to predict. It does not try: it checks only the 434 names that are
    // already plain identifiers, and compares case-insensitively because acronym case IS normalized
    // (`MCPStatus` → `McpStatus`, `ProviderAISDK` → `ProviderAisdk`). That covers 97% of the surface
    // with zero knowledge of the naming table.
    const document = (await Bun.file(specPath).json()) as Document
    const types = await Bun.file(path.join(genDir, "types.gen.ts")).text()

    const emitted = new Set([...types.matchAll(/^export type ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!.toLowerCase()))
    const plain = Object.keys(document.components.schemas).filter((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name))
    const missing = plain.filter((name) => !emitted.has(name.toLowerCase())).sort()

    expect(
      missing,
      [
        "packages/sdk/openapi.json declares schemas that src/v2/gen/types.gen.ts does not emit — the",
        "typed client is stale against the spec (the route check above cannot see this).",
        `Fix:  ${REGEN}`,
      ].join("\n"),
    ).toEqual([])
    // Guards the guard: an over-strict identifier filter would empty `plain` and pass vacuously.
    expect(plain.length).toBeGreaterThan(400)
  })
})
