import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AdhocGuidance } from "@novaclaw/core/adhoc-tools/guidance"
import { copySessionRecipes, saveSessionRecipe, storeRootIn } from "@novaclaw/core/adhoc-tools"
import { Config } from "@novaclaw/core/config"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Global } from "@novaclaw/core/global"
import { SystemContext } from "@novaclaw/core/system-context"
import { Session } from "@novaclaw/schema/session"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const parentID = Session.ID.make("ses_adhoc_parent")
const childID = Session.ID.make("ses_adhoc_child")

const recipe = (name: string, description: string) => ({
  name,
  description,
  manual: `curl http://example.test/${name}`,
})

/**
 * Builds AdhocGuidance over a temp data root. The session store's root is reached through
 * `Global.Service`, which is what makes this hermetic — `Global.Path.data` is a process-memoized
 * XDG resolution, so an env-var override would race every other file in the run.
 */
const withGuidance = <A, E, R>(
  body: (input: { root: string; guidance: AdhocGuidance.Interface }) => Effect.Effect<A, E, R>,
  configured?: ReadonlyArray<{ name: string; description: string; manual: string }>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(AdhocGuidance.node, [
        [Global.node, Global.layerWith({ data: tmp.path })],
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed(
                  configured === undefined
                    ? []
                    : [new Config.Document({ type: "document", info: new Config.Info({ adhoc_tools: configured }) })],
                ),
            }),
          ),
        ],
      ])
      return Effect.gen(function* () {
        return yield* body({ root: storeRootIn(tmp.path), guidance: yield* AdhocGuidance.Service })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const baselineFor = (guidance: AdhocGuidance.Interface, sessionID: Session.ID) =>
  guidance.load(sessionID).pipe(
    Effect.flatMap(SystemContext.initialize),
    Effect.map((it) => it.baseline),
  )

describe("AdhocGuidance session scope", () => {
  // The defect this file exists for: `copySessionRecipes` hands a spawned child the parent's
  // recipes BEFORE the child's first turn, so the child's very first epoch baseline is where the
  // inheritance has to show up. It never did — the capability transferred and the prompt was silent.
  it.live("a spawned child's first baseline lists the recipes copy-on-spawn gave it", () =>
    withGuidance(({ root, guidance }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => saveSessionRecipe(parentID, recipe("weather", "Fetch a forecast"), { root }))
        const copied = yield* Effect.promise(() => copySessionRecipes(parentID, childID, { root }))
        expect(copied).toBe(1)

        const baseline = yield* baselineFor(guidance, childID)
        expect(baseline).toContain("<adhoc_tools>")
        expect(baseline).toContain("weather — Fetch a forecast")
      }),
    ),
  )

  // A sibling session must not see it: the store is per-session and the guidance must key off the
  // id it was handed, not "whatever recipes exist".
  it.live("a session that was not given the recipes does not list them", () =>
    withGuidance(({ root, guidance }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => saveSessionRecipe(parentID, recipe("weather", "Fetch a forecast"), { root }))
        expect(yield* baselineFor(guidance, childID)).toContain("No ad-hoc tools are currently configured.")
      }),
    ),
  )

  // tool_manual resolves `mergeRecipes(configured, session)`; the prompt has to list the same set,
  // or the model reads one vocabulary and the tool answers another.
  it.live("config and session scopes merge with session winning by name, as tool_manual resolves them", () =>
    withGuidance(
      ({ root, guidance }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            saveSessionRecipe(childID, recipe("weather", "Session-defined forecast"), { root }),
          )
          const baseline = yield* baselineFor(guidance, childID)
          expect(baseline).toContain("stocks — Configured quotes")
          expect(baseline).toContain("weather — Session-defined forecast")
          expect(baseline).not.toContain("Configured forecast")
        }),
      [recipe("weather", "Configured forecast"), recipe("stocks", "Configured quotes")],
    ),
  )

  // The epoch reconciles every turn, so a define_tool mid-session now also reaches the prompt as an
  // update. define_tool's own output still says it too — this is additive, not a replacement.
  it.live("defining a recipe mid-session produces a context update on the next turn", () =>
    withGuidance(({ root, guidance }) =>
      Effect.gen(function* () {
        const initialized = yield* guidance.load(childID).pipe(Effect.flatMap(SystemContext.initialize))
        expect(initialized.baseline).toContain("No ad-hoc tools are currently configured.")

        yield* Effect.promise(() => saveSessionRecipe(childID, recipe("stocks", "Quote lookup"), { root }))

        const reconciled = yield* guidance
          .load(childID)
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot)))
        expect(reconciled).toMatchObject({
          _tag: "Updated",
          text: expect.stringContaining("stocks — Quote lookup"),
        })
      }),
    ),
  )
})
