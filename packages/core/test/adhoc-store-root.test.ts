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
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { SystemContext } from "@novaclaw/core/system-context"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { DefineToolTool } from "@novaclaw/core/tool/define-tool"
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
 * The first test is the behavioural pin. The ledger below WAS the residue — four other production
 * call sites resolving the root the module-level way. All four were converged on 2026-07-29, so the
 * ledger is now empty and its first assertion has hardened from "every offender is written down"
 * into "there are no offenders". That is the ratchet doing what it was for.
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

/** `define_tool` is permission-gated; the gate is not what this file is about, so grant it. */
const permission = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })

/**
 * AdhocGuidance + tool_manual + define_tool in ONE graph, over ONE overridden data root. That is
 * the point: these three are the write half and the two read halves of a single store, and the only
 * way a root disagreement can be observed at all is to hold them together under an overridden
 * `Global`.
 */
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
              DefineToolTool.node,
            ]),
            [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [ToolOutputStore.node, outputStore],
              [PermissionV2.node, permission],
              [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
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
        const baseline = yield* guidance.load(sessionID).pipe(
          Effect.flatMap(SystemContext.initialize),
          Effect.map((context) => context.baseline),
        )
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

  it.live("define_tool WRITES where the prompt reads — the pair that would have diverged silently", () =>
    // The writer half. `define-tool.ts` used to call `saveSessionRecipe` with no root, so under an
    // overridden Global it wrote to the real XDG data dir while `AdhocGuidance` (already on the
    // service) listed the overridden one. Nothing failed loudly: the model was simply told its
    // brand-new tool did not exist. Assert the file lands under the OVERRIDDEN root, then that both
    // readers see it.
    withBoth(({ root, guidance, registry }) =>
      Effect.gen(function* () {
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-define",
              name: "define_tool",
              input: { name: "tides", description: "Tide table", manual: "curl http://example.test/tides" },
            },
          }),
        ).toEqual({ type: "text", value: DefineToolTool.toModelOutput({ name: "tides", scope: "session" }) })

        // Where it actually landed — the assertion the grep ledger cannot make.
        const file = path.join(root, `${sessionID}.json`)
        expect(fs.existsSync(file)).toBe(true)
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
          { name: "tides", description: "Tide table", manual: "curl http://example.test/tides" },
        ])

        // …and both readers in the same graph now agree it exists.
        const baseline = yield* guidance.load(sessionID).pipe(
          Effect.flatMap(SystemContext.initialize),
          Effect.map((context) => context.baseline),
        )
        expect(baseline).toContain("tides — Tide table")
        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-manual-tides", name: "tool_manual", input: { name: "tides" } },
          }),
        ).toEqual({
          type: "text",
          value: ToolManualTool.toModelOutput({
            name: "tides",
            description: "Tide table",
            manual: "curl http://example.test/tides",
          }),
        })
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
 * ✅ **The ledger is EMPTY (2026-07-29).** Its four entries — `tool/define-tool.ts` (writes the
 * store `AdhocGuidance` reads), `session/spawner.ts` and `messenger/gateway.ts` (the two 4D
 * copy-on-spawn sites) and `novaclaw`'s HTTP handler — were converged onto `Global.Service` in one
 * change, and this test is the proof: each one failed here BY NAME ("drop the ledger entry") until
 * its line was removed.
 *
 * Be honest about what that bought. `Global.layerWith` has no production caller, so all six sites
 * resolved to the same string in a shipped instance and no user-visible bug was fixed — this is
 * hygiene plus testability. What it does buy is that a graph which overrides `Global` (this file,
 * or any future per-instance data root) can no longer have two halves of the ad-hoc store looking
 * in different directories, and the writer/reader pair — `define_tool` writes, the prompt lists —
 * is exactly where such a divergence would have been silent rather than loud.
 *
 * An empty ledger means the first assertion below is no longer "everyone is written down" but
 * "nobody is left". Re-opening it is a deliberate, reviewable edit — which is the point.
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

const COMPOSES_ROOT = /\bstoreRootIn\s*\(/

/**
 * Split the store's callers into the two buckets. Extracted so the negative control below can run
 * the REAL classifier over synthetic files: with the tree fully converged there is no longer a live
 * offender to prove the `onModulePath` bucket can be non-empty, and a bucket that could never fill
 * would report "no offenders" forever.
 */
function classify(files: ReadonlyArray<{ name: string; text: string }>) {
  const callers = files.filter((file) => file.name !== DEFINER && VERBS.test(file.text))
  return {
    onService: callers.filter((file) => COMPOSES_ROOT.test(file.text)).map((file) => file.name),
    onModulePath: callers.filter((file) => !COMPOSES_ROOT.test(file.text)).map((file) => file.name),
  }
}

const { onService, onModulePath } = classify(sources)
const callers = [...onService, ...onModulePath]

/**
 * Every caller that still lets `Global.Path.data` decide, and what it does. Can only SHRINK — and
 * as of 2026-07-29 it is EMPTY (see the block comment above). A new entry here is an admission that
 * a call site cannot reach `Global.Service`; prefer converging it.
 */
const LEDGER = new Map<string, string>()

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
    // ⚠️ This used to assert `onModulePath.length > 0` against the live tree. That assertion is
    // gone because the tree converged — it would now fail for the RIGHT reason, which makes it
    // useless as a control. Run the real classifier over synthetic files instead: both buckets must
    // still be reachable, or the guard above is an empty list that can never fill.
    const synthetic = classify([
      { name: "packages/x/src/converged.ts", text: "listSessionRecipes(id, { root: storeRootIn(global.data) })" },
      { name: "packages/x/src/offender.ts", text: "await listSessionRecipes(context.sessionID)" },
      { name: "packages/x/src/unrelated.ts", text: "const recipes = somethingElse(context.sessionID)" },
    ])
    expect(synthetic.onService).toEqual(["packages/x/src/converged.ts"])
    expect(synthetic.onModulePath).toEqual(["packages/x/src/offender.ts"])

    // And on the real tree: every caller is now on the service, none is double-counted.
    expect(onService.length).toBeGreaterThan(0)
    expect(onModulePath).toEqual([])
    expect(onService.filter((name) => onModulePath.includes(name))).toEqual([])
  })
})
