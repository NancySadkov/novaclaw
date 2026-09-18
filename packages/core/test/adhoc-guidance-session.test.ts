import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AdhocGuidance } from "@novaclaw/core/adhoc-tools/guidance"
import { copySessionRecipes, saveSessionRecipe, storeRootIn } from "@novaclaw/core/adhoc-tools"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Global } from "@novaclaw/core/global"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { EFFECTIVE_CONFIG_DEFAULTS } from "@novaclaw/core/session/config-resolve"
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
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(AdhocGuidance.node, [
        [Global.node, Global.layerWith({ data: tmp.path })],
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

  // The ONE recipe set: the prompt lists it and `tool_manual` resolves from it, so the two
  // cannot disagree. The instance library is gone (per-agent tuning owns recipes), so the
  // scopes left are the officer's own and the session's `define_tool` — session wins.
  it.live("officer and session scopes merge with session winning by name", () =>
    withOfficerRecipes(
      ({ root, guidance }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            saveSessionRecipe(childID, recipe("weather", "Session-defined forecast"), { root }),
          )
          const baseline = yield* baselineFor(guidance, childID)
          expect(baseline).toContain("stocks — Officer quotes")
          expect(baseline).toContain("weather — Session-defined forecast")
          expect(baseline).not.toContain("Officer forecast")
        }),
      { adhocTools: [recipe("weather", "Officer forecast"), recipe("stocks", "Officer quotes")] },
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

/**
 * The officer layer, hermetically: the resolution service is stubbed to return one canned
 * officer, so these cases pin the merge without standing up sessions, agents or a database.
 * The stub is the honest shape — `forSession` reads officer recipes off the same resolution
 * every turn uses, and here that resolution is simply authored by hand.
 */
const withOfficerRecipes = <A, E, R>(
  body: (input: { root: string; guidance: AdhocGuidance.Interface }) => Effect.Effect<A, E, R>,
  officer: { readonly adhocTools?: ReadonlyArray<{ name: string; description: string; manual: string; enabled?: boolean }> },
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(AdhocGuidance.node, [
        [Global.node, Global.layerWith({ data: tmp.path })],
        [
          SessionEffectiveConfig.node,
          Layer.succeed(
            SessionEffectiveConfig.Service,
            SessionEffectiveConfig.Service.of({
              resolution: () =>
                Effect.succeed({
                  config: { ...EFFECTIVE_CONFIG_DEFAULTS, ...officer },
                  defaults: { ...EFFECTIVE_CONFIG_DEFAULTS, ...officer },
                  applied: [] as const,
                  refused: [] as const,
                  deferred: [] as const,
                }),
              // `resolve` (not `resolution`) is what `forSession` reads — the chain-resolved
              // config, which carries the officer fold for delivery fields. A stub that returns
              // the bare shipped defaults here resolves to no officer at all.
              resolve: () => Effect.succeed({ ...EFFECTIVE_CONFIG_DEFAULTS, ...officer }),
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

describe("AdhocGuidance officer scope", () => {
  it.live("the officer's private recipes are the list the prompt shows", () =>
    withOfficerRecipes(
      ({ guidance }) =>
        Effect.gen(function* () {
          const baseline = yield* baselineFor(guidance, childID)
          expect(baseline).toContain("mine — Officer-only")
          expect(baseline).toContain("stocks — Officer-only")
        }),
      { adhocTools: [recipe("mine", "Officer-only"), recipe("stocks", "Officer-only")] },
    ),
  )

  it.live("a disabled officer recipe is dropped, and there is no other layer to fall back to", () =>
    withOfficerRecipes(
      ({ guidance }) =>
        Effect.gen(function* () {
          const baseline = yield* baselineFor(guidance, childID)
          expect(baseline).not.toContain("Officer-only")
          expect(baseline).toContain("No ad-hoc tools are currently configured.")
        }),
      { adhocTools: [{ ...recipe("stocks", "Officer-only"), enabled: false }] },
    ),
  )
})
