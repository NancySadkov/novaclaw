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
// ⚠️ Whoever fixes a failure here: the regen ritual is `bun run --cwd packages/sdk/js regen`. Do NOT
// run `bun run script/generate.ts` from the repo root — it ends in `script/format.ts`, whose whole
// body is `prettier --ignore-unknown --write .` over ~390 files, and `.prettierignore` excludes only
// three paths.

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
          "⚠️  NOT `bun run script/generate.ts` — that ends in a whole-repo prettier sweep (~390 files).",
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
})
