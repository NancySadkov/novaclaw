export * as ToolPolicyGate from "./tool-policy-gate"

import { Context, Effect, Layer, Scope } from "effect"
import { Config } from "./config"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { PermissionV2 } from "./permission"
import { ProjectFileCache } from "./project-file-cache"
import type { AgentV2 } from "./agent"
import type { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { ToolPolicy } from "./tool-policy"
import { SessionPolicyDecisionTable } from "./tool-policy.sql"

/**
 * The seam that runs installed pre-action policies before a tool executes.
 *
 * `tool-policy.ts` holds the vocabulary, the order and the merge, and carries the design argument.
 * This module is everything that touches the world: which providers apply to THIS call, the budget,
 * spending an approval through the permission service that already exists, writing the receipt, and
 * handing the seam either the (possibly rewritten) arguments or a refusal.
 *
 * ⚠️ **The one caller is `ToolRegistry`'s `settleRaw`.** Do not add a second: two call sites for one
 * decision diverge at the one nobody exercises (ruling 6), and the whole reason the gate sits under
 * the dispatcher rather than inside the tools is that a tool added later inherits it.
 *
 * ── AN APPROVAL USES THE EXISTING PERMISSION EVALUATOR ────────────────────────────────────────
 *
 * 🔴 An `approve` outcome is spent through `PermissionV2.assert` with `minimumEffect: "ask"`, which
 * is the field that already exists for *"require at least this verdict even when ordinary policy
 * would be more permissive"*. The permission service resolves the request immediately from the
 * effective rules; it has no pending approval store or UI side channel.
 *
 * ⚠️ It also means a policy approval can be DENIED by ordinary permission rules — `minimumEffect`
 * raises the floor, it does not lower the ceiling. That is the correct
 * direction: a policy may add a gate, never remove one.
 */

export interface ScreenInput {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly tool: string
  readonly toolCallID: string
  readonly input: unknown
}

export type Screened =
  /** Run the tool with `input` — the model's arguments, or the patched ones. */
  | {
      readonly kind: "run"
      readonly input: unknown
      /** The sentence to put in front of the tool's own result, or absent when nothing intervened. */
      readonly note?: string
    }
  /** Do not run the tool. `message` is model-facing and already explains itself. */
  | { readonly kind: "refuse"; readonly message: string; readonly halt: boolean }

export interface Interface {
  /**
   * Install providers for the life of the caller's scope.
   *
   * ⚠️ **`ToolPolicyBuiltin` is the only caller, and that is a DECISION rather than an omission
   * (2026-08-19).** `ToolPolicy.Provider` is deliberately the interface a third party would
   * implement — the shipped policies are not a privileged category — but no path from outside this
   * repo reaches here, and none is being added in v0.2.0. All four surfaces AGENTS.md names were
   * weighed: the app registry stores manifests and no code, a tool is model-elected and would end up
   * reading and rewriting its siblings' arguments, a spawned session is neither deterministic nor
   * inside the budget, and MCP fails on AVAILABILITY rather than on speed — out of process the
   * budget below stops bounding a function call and starts bounding a process lifecycle whose own
   * default in this codebase is 30 s, six times what the gate will wait, with every tool call in the
   * instance refused meanwhile (`safetyCritical` defaults true).
   *
   * The intended host is the in-process `{plugin,plugins}/*.ts` glob ruling 5 keeps. Three things
   * must be true first, two of them defects in that door and one of them work this seam owns:
   * `Provider` carries no PROVENANCE, so the model-facing note and refusal (see `refusalMessage` and
   * `ToolRegistry`'s `withPolicyNote`) cannot be framed as a stranger's text the way the Settings and
   * receipt surfaces already frame it. Measurements and the full list:
   * `notes/reports/projects-program-2026-08-18.md` → *"Who may call `ToolPolicyGate.install`"*.
   *
   * Scoped, like `ToolRegistry.register`, so a test or a plugin that installs a policy takes it
   * back out again. Registration validates the whole batch before touching anything, for the
   * reason `ToolRegistry.register` states: one refused entry must take its siblings with it rather
   * than leave half an installation behind.
   */
  readonly install: (
    providers: readonly ToolPolicy.Provider[],
  ) => Effect.Effect<void, ToolPolicy.RegistrationError, Scope.Scope>
  /** Every installed policy id, sorted. */
  readonly installed: () => Effect.Effect<readonly string[]>
  /**
   * Every installed policy, with what it does and whether it is switched on — the management
   * surface's whole input.
   *
   * ⚠️ `enabled` is computed HERE rather than by the caller, because it is a fact about what the
   * gate will do on the next tool call. A route that re-derived it from the config would be a
   * second answer to "is this guard running", and the two would disagree the day the rule changes.
   */
  readonly list: () => Effect.Effect<readonly Installed[]>
  /** Decide about one tool call. Never fails: a refusal is a value, not an error channel. */
  readonly screen: (input: ScreenInput) => Effect.Effect<Screened>
}

/** One installed policy, as a surface that lists them needs it. */
export interface Installed {
  readonly id: string
  /** The provider's own one-line description. AUTHOR TEXT — a plugin writes its own. */
  readonly describe: string
  /** `false` marks a policy a folder must opt into by naming it in its `novaclaw.json`. */
  readonly alwaysOn: boolean
  /** `false` marks an ADVISORY policy, whose failure to answer does not refuse the call. */
  readonly safetyCritical: boolean
  /** Whether it will be consulted at all — `config.tool_policy.<id>.enabled`, absent = yes. */
  readonly enabled: boolean
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ToolPolicyGate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const projects = yield* ProjectFileCache.Service
    const sessions = yield* SessionStore.Service

    const providers = new Map<string, ToolPolicy.Provider>()

    const install: Interface["install"] = (batch) =>
      Effect.gen(function* () {
        if (batch.length === 0) return
        // A PRE-PASS over the batch, then an uninterruptible commit. Same ordering, and the same
        // reason, as `ToolRegistry.register`.
        const seen = new Set(providers.keys())
        for (const provider of batch) {
          yield* ToolPolicy.validateRegistration(provider.id, seen)
          seen.add(provider.id)
        }
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            for (const provider of batch) providers.set(provider.id, provider)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const provider of batch) {
                  // Only remove the registration we made. A later installation under the same id is
                  // impossible (validate refuses it), so this is exact rather than merely careful.
                  if (providers.get(provider.id) === provider) providers.delete(provider.id)
                }
              }),
            )
          }),
        )
      })

    /**
     * The ids the person at this computer has switched OFF.
     *
     * 🔴 **Read THROUGH `config.entries()` on every screened call, never hoisted** — ruling 3, the
     * same discipline the Config layer records for itself: *a settings change is not a reboot*. A
     * guard the user just turned off must be off for the very next tool call, and a guard they just
     * turned back on must be consulted again without restarting the instance. Hoisting this would
     * be a cache with no invalidation, on a switch whose whole purpose is to take effect now.
     *
     * ⚠️ Cost, and it IS on the hot path (once per screened tool call): one single-table SELECT
     * plus the settings decode `Config.entries()` already performs. That is the same read
     * `tool/bash.ts` makes per call and the runner makes per turn — measured beside the provider
     * budget in `test/tool-policy.test.ts`. It is deliberately paid AFTER the in-memory
     * applicability filter, so an instance with nothing installed pays nothing at all.
     *
     * Later documents win per id, exactly as every other sparse settings map resolves. The FOLD
     * itself lives in `tool-policy.ts` as a pure function, because its layered case is unreachable
     * through the real Config layer (there is one synthetic settings document) and a branch that no
     * test can reach is a comment, not code. This side only gathers the documents.
     */
    const disabledIDs = Effect.fnUntraced(function* () {
      const entries = yield* config.entries()
      return ToolPolicy.disabledPolicies(
        entries.filter((entry) => entry.type === "document").map((entry) => entry.info.tool_policy),
      )
    })

    const list: Interface["list"] = () =>
      Effect.gen(function* () {
        const off = yield* disabledIDs()
        return [...providers.values()]
          .map((provider) => ({
            id: provider.id,
            describe: provider.describe,
            alwaysOn: ToolPolicy.alwaysOn(provider),
            safetyCritical: ToolPolicy.safetyCritical(provider),
            enabled: !off.has(provider.id),
          }))
          .toSorted((a, b) => a.id.localeCompare(b.id))
      })

    /**
     * The session's working folder.
     *
     * ⚠️ The SESSION's folder, not this location's directory, for `permission.ts`'s reason: the two
     * differ whenever a session was opened somewhere else, and the folder the agent is working in is
     * the one whose `novaclaw.json` selects its policies. A session that vanished mid-call falls back
     * to the location's own folder — for a gate, the fallback direction has to be the one that still
     * consults something.
     */
    const directoryOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      return session?.location.directory ?? location.directory
    })

    /**
     * Ask one provider, under the budget.
     *
     * ⚠️ `Effect.timeout` AND `Effect.catchCause`: a provider that hangs and a provider that throws
     * are the same fact — we do not have its opinion — and only one of them looks like a bug. A
     * `catchCause` rather than `catch` because a provider that dies with a DEFECT (the shape a bad
     * `undefined.foo` takes) must not take the turn down; `compose` fails it closed if it is
     * safety-critical, which is a better answer than a stack trace in the transcript.
     */
    const consult = (provider: ToolPolicy.Provider, request: ToolPolicy.Request) =>
      provider.evaluate(request).pipe(
        Effect.timeout(ToolPolicy.PROVIDER_BUDGET),
        Effect.map(
          (outcome): ToolPolicy.Result => ({
            id: provider.id,
            kind: "answered",
            outcome,
            safetyCritical: ToolPolicy.safetyCritical(provider),
          }),
        ),
        Effect.catchTag("TimeoutError", () =>
          Effect.succeed<ToolPolicy.Result>({
            id: provider.id,
            kind: "timed-out",
            safetyCritical: ToolPolicy.safetyCritical(provider),
          }),
        ),
        Effect.catchCause(() =>
          Effect.succeed<ToolPolicy.Result>({
            id: provider.id,
            kind: "errored",
            safetyCritical: ToolPolicy.safetyCritical(provider),
          }),
        ),
      )

    const record = (input: {
      readonly sessionID: SessionSchema.ID
      readonly toolCallID: string
      readonly tool: string
      readonly decision: ToolPolicy.Decision
      /** The decision's own type is overridden when a human answered an approval. */
      readonly as?: ToolPolicy.OutcomeType
      readonly detail?: string
    }) =>
      db
        .insert(SessionPolicyDecisionTable)
        .values({
          id: ToolPolicy.decisionID(input.sessionID, input.toolCallID, input.tool),
          session_id: input.sessionID,
          tool_call_id: input.toolCallID,
          tool: input.tool,
          decision: input.as ?? input.decision.type,
          detail: input.detail ?? input.decision.detail,
          providers: input.decision.providers,
          patched: Object.keys(input.decision.patch).length === 0 ? null : { ...input.decision.patch },
          time_created: Date.now(),
        })
        .onConflictDoUpdate({
          target: SessionPolicyDecisionTable.id,
          set: {
            decision: input.as ?? input.decision.type,
            detail: input.detail ?? input.decision.detail,
            providers: input.decision.providers,
            patched: Object.keys(input.decision.patch).length === 0 ? null : { ...input.decision.patch },
            time_created: Date.now(),
          },
        })
        .run()
        // 🔴 `orDie`, and the ORDER around it is the safety property: the receipt is written BEFORE
        // the tool runs, so a database defect stops the call instead of letting an intervention apply
        // unrecorded. "Bind every intervention to a receipt" is only a promise if the binding is what
        // gates the action rather than something attempted afterwards.
        .pipe(Effect.orDie)

    const screen: Interface["screen"] = Effect.fn("ToolPolicyGate.screen")(function* (input) {
      const directory = yield* directoryOf(input.sessionID)
      const project = yield* projects.read(directory, directory)
      const projectFault = ProjectFileCache.fault(project)
      if (projectFault !== undefined)
        return {
          kind: "refuse",
          halt: false,
          message: ProjectFileCache.refusal(projectFault),
        } satisfies Screened
      const requested = project.policies

      // A folder that asked for a guard which is not installed gets a refusal, never silence.
      if (requested.length > 0) {
        const missing = requested.filter((id) => !providers.has(id)).toSorted()
        if (missing.length > 0)
          return {
            kind: "refuse",
            halt: false,
            message: ToolPolicy.missingPolicyRefusal(
              missing,
              project.file ?? `${directory}/novaclaw.json`,
              [...providers.keys()].toSorted(),
            ),
          } satisfies Screened
      }

      const wanted = new Set(requested)
      // ⚠️ Deliberately NOT sorted here. `compose` sorts, and a second sort on this side would make
      // the first one untestable: the seam's determinism test would keep passing with `compose`'s
      // sort deleted, which is the shape of a guard that is green because something else is doing
      // its job. One decision, one place (ruling 6) — the order belongs to the composer's contract.
      const candidates = [...providers.values()].filter(
        (provider) => ToolPolicy.alwaysOn(provider) || wanted.has(provider.id),
      )
      // The fast path, and it is the normal one: nothing installed applies, so nothing is consulted,
      // nothing is composed, no row is written — and, deliberately, the settings store is not read.
      // Placing the config read AFTER this is what keeps an instance with no policies free.
      if (candidates.length === 0 && requested.length === 0)
        return { kind: "run", input: input.input } satisfies Screened

      // 🔴 What the user switched off in Settings. The direction below is the same fail-closed one
      // the missing case uses: a folder that DECLARED a policy which is now off is refused, because
      // "the guard you asked for is not running" must never be spelled the same way as "you asked
      // for nothing". A policy nobody's folder declared simply stops being consulted.
      const off = yield* disabledIDs()
      const disabledRequested = requested.filter((id) => providers.has(id) && off.has(id)).toSorted()
      if (disabledRequested.length > 0)
        return {
          kind: "refuse",
          halt: false,
          message: ToolPolicy.disabledPolicyRefusal(disabledRequested, project.file ?? `${directory}/novaclaw.json`),
        } satisfies Screened

      const applicable = candidates.filter((provider) => !off.has(provider.id))
      if (applicable.length === 0) return { kind: "run", input: input.input } satisfies Screened

      const request: ToolPolicy.Request = {
        sessionID: input.sessionID,
        agent: input.agent,
        tool: input.tool,
        toolCallID: input.toolCallID,
        // A non-object call input (a provider can emit one) is shown as an empty record rather than
        // hidden: a policy must still get to rule on the TOOL even when it cannot read the arguments.
        input:
          typeof input.input === "object" && input.input !== null && !Array.isArray(input.input)
            ? (input.input as Record<string, unknown>)
            : {},
        directory,
      }

      // ⚠️ Concurrent, and the concurrency is exactly why `compose` is order-independent: providers
      // finish in whatever order they finish, the results are sorted by id before anything reads
      // them, and the decision is a function of the SET. `Effect.forEach` preserves input order in
      // its output, which would mask an ordering bug — the sort inside `compose` is what actually
      // holds the line, and `test/tool-policy.test.ts` → "shuffling installation AND completion
      // order yields an identical decision and receipt" shuffles both to prove it.
      const results = yield* Effect.forEach(applicable, (provider) => consult(provider, request), {
        concurrency: "unbounded",
      })
      const decision = ToolPolicy.compose(results)

      if (decision.type === "allow") {
        // Nothing intervened. A row is still written when a provider failed to answer, because the
        // ABSENCE of a row is a positive claim that every installed policy allowed this call in time.
        const unavailable = decision.providers.some(
          (entry) => entry.outcome === "timed-out" || entry.outcome === "errored",
        )
        if (unavailable)
          yield* record({
            sessionID: input.sessionID,
            toolCallID: input.toolCallID,
            tool: input.tool,
            decision,
            detail:
              `The call ran, and not every installed policy answered: ` +
              decision.providers
                .filter((entry) => entry.outcome === "timed-out" || entry.outcome === "errored")
                .map((entry) => `\`${entry.id}\` ${entry.outcome}`)
                .join(", ") +
              `. Those policies are advisory (not safety-critical), so their silence did not refuse the call.`,
          })
        return { kind: "run", input: input.input } satisfies Screened
      }

      if (decision.type === "deny" || decision.type === "halt") {
        yield* record({
          sessionID: input.sessionID,
          toolCallID: input.toolCallID,
          tool: input.tool,
          decision,
        })
        return {
          kind: "refuse",
          halt: decision.type === "halt",
          message: refusalMessage(decision),
        } satisfies Screened
      }

      if (decision.type === "approve") {
        // Spend every approval, in policy-id order. All of them must be granted: two policies each
        // asking for a human is two separate questions, and answering one is not answering the other.
        for (const approval of decision.approvals) {
          const failure = yield* permission
            .assert({
              sessionID: input.sessionID,
              action: approval.action,
              resources: [...approval.resources],
              ...(approval.save === undefined ? {} : { save: [...approval.save] }),
              agent: input.agent,
              minimumEffect: "ask",
              metadata: {
                // The card has to say WHY it is asking, in `permission.ts`'s own words: a prompt
                // whose reason is invisible reads as a glitch. `metadata` is the existing channel;
                // no new wire shape is introduced for this.
                policyID: approval.id,
                policyReason: approval.reason,
                tool: input.tool,
              },
            })
            .pipe(
              Effect.as(undefined as unknown),
              // The permission service's whole failure channel, kept as a VALUE. Every member of it
              // is a refusal the model must be told about in its own words, and `denialMessage`
              // already owns that vocabulary — including the user's optional reject feedback.
              Effect.catch((error) => Effect.succeed(error as unknown)),
            )
          if (failure !== undefined) {
            const refused =
              PermissionV2.denialMessage(failure) ??
              `The approval requested by the policy \`${approval.id}\` was not granted, so nothing ran.`
            yield* record({
              sessionID: input.sessionID,
              toolCallID: input.toolCallID,
              tool: input.tool,
              decision,
              as: "deny",
              detail: `\`${approval.id}\` asked for approval and it was not granted: ${approval.reason}`,
            })
            return { kind: "refuse", halt: false, message: refused } satisfies Screened
          }
        }
      }

      // Approved, patched, or merely annotated: the call runs, and the receipt says what happened
      // BEFORE it does.
      yield* record({
        sessionID: input.sessionID,
        toolCallID: input.toolCallID,
        tool: input.tool,
        decision,
      })
      const patched =
        Object.keys(decision.patch).length === 0 ? input.input : ToolPolicy.applyPatch(request.input, decision.patch)
      return { kind: "run", input: patched, note: decision.detail } satisfies Screened
    })

    return Service.of({
      install,
      installed: () => Effect.sync(() => [...providers.keys()].toSorted()),
      list,
      screen,
    })
  }),
)

/**
 * What the model is told when a policy refuses.
 *
 * Shaped like `ProjectExclusion.refusal` and for the same reason: a bare "denied" is what makes an
 * agent retry the same call five different ways and then conclude the instance is broken. So it says
 * that a POLICY did this, which policy, why, and — for a halt — that the run is over rather than
 * merely blocked.
 */
export function refusalMessage(decision: ToolPolicy.Decision) {
  const shared =
    `${decision.detail} A pre-action policy is installed by whoever set this NovaClaw up, so no consent ` +
    `prompt and no permission change made from inside this session can widen it, and spelling the call ` +
    `differently will be refused the same way.`
  return decision.type === "halt"
    ? `${shared} This is a HALT, not a single refusal: stop working, and report what you had done and ` +
        `what was refused. Do not call another tool.`
    : `${shared} Continue with what you ARE able to do; if the task genuinely cannot finish without this ` +
        `call, name it in your reply and stop retrying.`
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Database.node, Location.node, PermissionV2.node, ProjectFileCache.node, SessionStore.node],
})
