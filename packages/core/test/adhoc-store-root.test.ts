import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { saveSessionRecipe, storeRootIn } from "@novaclaw/core/adhoc-tools"
import { AdhocGuidance } from "@novaclaw/core/adhoc-tools/guidance"
import { Config } from "@novaclaw/core/config"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Global } from "@novaclaw/core/global"
import { SessionV2 } from "@novaclaw/core/session"
import { SystemContext } from "@novaclaw/core/system-context"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolManualTool } from "@novaclaw/core/tool/tool-manual"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

/**
 * **ONE resolution path to the ad-hoc session store's root.**
 *
 * The store is read by two things that must agree by construction: `AdhocGuidance` renders the
 * system prompt's `<adhoc_tools>` list, and the `tool_manual` tool answers for a name the model
 * took FROM that list. `guidance.ts` resolves its root through `Global.Service`; `tool-manual.ts`
 * did not — it called `listSessionRecipes(sessionID)` with no root, falling back to the
 * module-level `Global.Path.data`, a process-memoized XDG snapshot.
 *
 * In production the two are the same string (`Global.make()` reads `Global.Path`, and
 * `Global.layerWith` has zero production callers), so nothing was broken today. That is precisely
 * why it needed a check: the agreement held **by accident**, and the moment a graph overrides
 * Global — this file, or any future per-instance data root — the prompt lists a recipe whose
 * manual the tool then reports missing. A tool telling the model "No ad-hoc tool named weather"
 * about a name the prompt just advertised is ruling 2's *a fault is never described falsely*.
 *
 * The first test is the behavioural pin. The ledger below is the residue: four other production
 * call sites still resolve the root the module-level way, and it can only shrink.
 */

const sessionID = SessionV2.ID.make("ses_adhoc_store_root")

const recipe = {
  name: "weather",
  description: "Fetch a forecast",
  manual: "curl http://example.test/weather?q=<city>",
}

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})

/** AdhocGuidance + tool_manual in ONE graph, over ONE overridden data root. That is the point. */
const withBoth = <A, E, R>(
  body: (input: {
    root: string
    guidance: AdhocGuidance.Interface
    registry: ToolRegistry.Interface
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        return yield* body({
          root: storeRootIn(tmp.path),
          guidance: yield* AdhocGuidance.Service,
          registry: yield* ToolRegistry.Service,
        })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              ToolRegistry.node,
              ToolRegistry.toolsNode,
              AdhocGuidance.node,
              ToolManualTool.node,
            ]),
            [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [ToolOutputStore.node, outputStore],
              [
                Config.node,
                Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
              ],
            ],
          ),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("the ad-hoc store root is resolved once, through Global.Service", () => {
  it.live("the prompt lists a session recipe and tool_manual can open it — same graph, same root", () =>
    withBoth(({ root, guidance, registry }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => saveSessionRecipe(sessionID, recipe, { root }))

        // Half one: the prompt advertises it. This half passed before the fix too — guidance was
        // already on the service.
        const baseline = yield* guidance
          .load(sessionID)
          .pipe(Effect.flatMap(SystemContext.initialize), Effect.map((context) => context.baseline))
        expect(baseline).toContain("weather — Fetch a forecast")

        // Half two: the tool answers for the name the prompt just advertised. This is the half that
        // FAILED before the fix — `tool-manual.ts` read the real `Global.Path.data`, found nothing,
        // and returned `No ad-hoc tool named "weather". Available: (none)` as a ToolFailure.
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-manual", name: "tool_manual", input: { name: "weather" } },
          }),
        ).toEqual({ type: "text", value: ToolManualTool.toModelOutput(recipe) })
      }),
    ),
  )

  it.live("a name that really is absent still gets the honest answer", () =>
    // The negative control for the test above: it must be possible to FAIL to find a recipe, or the
    // assertion would pass against a tool that says yes to everything.
    withBoth(({ root, registry }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => saveSessionRecipe(sessionID, recipe, { root }))
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-missing", name: "tool_manual", input: { name: "stocks" } },
          }),
        ).toEqual({ type: "error", value: 'No ad-hoc tool named "stocks". Available: weather' })
      }),
    ),
  )
})

/**
 * ─── the residue ledger: who still resolves the root the module-level way ───────────────────────
 *
 * Shrink-only, per todo.md ruling 1. `storeRootIn` exists so the directory name is spelled once;
 * a file that composes it has resolved the root through `Global.Service`, a file that calls the
 * store functions without it inherits `Global.Path.data` at the point of use.
 *
 * The four entries below are NOT the same severity as the one this file fixed — none of them is
 * paired with a reader inside the same graph the way `tool_manual` is paired with the prompt — but
 * they are the same shape, and `define-tool.ts` in particular WRITES the store that guidance reads.
 * They live outside this batch's file ownership; the ledger records them so the next agent inherits
 * a list rather than a rediscovery.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])

/** The store's public verbs. A file that calls one of these has picked a root, explicitly or not. */
const VERBS = /\b(listSessionRecipes|saveSessionRecipe|removeSessionRecipe|copySessionRecipes)\s*\(/

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string, out: { name: string; text: string }[]): { name: string; text: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out)
      continue
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) continue
    if (/\.(test|smoke)\.[cm]?[jt]sx?$/.test(entry.name)) continue
    if (!/\.[cm]?tsx?$/.test(entry.name)) continue
    const name = path.relative(ROOT, full).replaceAll("\\", "/")
    if (!name.includes("/src/")) continue
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

const sources = collect(path.join(ROOT, "packages"), [])

/** The module that DEFINES the store is not a call site — it is the thing being resolved. */
const DEFINER = "packages/core/src/adhoc-tools.ts"

const callers = sources.filter((file) => file.name !== DEFINER && VERBS.test(file.text))
const onService = callers.filter((file) => /\bstoreRootIn\s*\(/.test(file.text)).map((file) => file.name)
const onModulePath = callers.filter((file) => !/\bstoreRootIn\s*\(/.test(file.text)).map((file) => file.name)

/** Every caller that still lets `Global.Path.data` decide, and what it does. Can only SHRINK. */
const LEDGER = new Map<string, string>([
  ["packages/core/src/tool/define-tool.ts", "saveSessionRecipe — WRITES the store AdhocGuidance reads."],
  ["packages/core/src/session/spawner.ts", "copySessionRecipes — 4D copy-on-spawn, parent → child."],
  ["packages/core/src/messenger/gateway.ts", "copySessionRecipes — the gateway's hand-rolled duplicate of the above."],
  [
    "packages/novaclaw/src/server/routes/instance/httpapi/handlers/adhoc.ts",
    "list + removeSessionRecipe — the HTTP surface; a separate process from any test override.",
  ],
])

describe("the store-root ledger", () => {
  test("the sweep reached the tree", () => {
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map((file) => file.name)).toContain(DEFINER)
    expect(callers.length).toBeGreaterThanOrEqual(5)
  })

  test("the two files that must agree both resolve through the service", () => {
    // Not "some files do" — these two specifically, because they are the pair the first test
    // exercises: one renders the prompt list, the other answers for a name from it.
    expect(onService).toContain("packages/core/src/adhoc-tools/guidance.ts")
    expect(onService).toContain("packages/core/src/tool/tool-manual.ts")
  })

  test("every remaining module-level caller is ledgered, and the ledger can only shrink", () => {
    expect(
      onModulePath
        .filter((name) => !LEDGER.has(name))
        .map(
          (name) =>
            `${name} calls the ad-hoc session store without composing storeRootIn(<Global.Service>.data). ` +
            "Resolve the root through the service, or add a ledger entry saying why it cannot.",
        ),
    ).toEqual([])

    expect(
      [...LEDGER.keys()]
        .filter((name) => !onModulePath.includes(name))
        .map((name) => `${name} no longer resolves the store root from Global.Path — drop the ledger entry`),
    ).toEqual([])
  })

  test("the classifier actually bites (negative control)", () => {
    // A guard whose two buckets could never differ would report an empty offender list forever.
    expect(onModulePath.length).toBeGreaterThan(0)
    expect(onService.length).toBeGreaterThan(0)
    expect(onService.filter((name) => onModulePath.includes(name))).toEqual([])
    // …and the discriminator itself, on the two shapes verbatim.
    expect(VERBS.test("await listSessionRecipes(context.sessionID)")).toBe(true)
    expect(/\bstoreRootIn\s*\(/.test("listSessionRecipes(id, { root: storeRootIn(global.data) })")).toBe(true)
    expect(/\bstoreRootIn\s*\(/.test("listSessionRecipes(context.sessionID)")).toBe(false)
  })
})
