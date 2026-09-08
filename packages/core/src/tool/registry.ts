export * as ToolRegistry from "./registry"

import {
  ToolFailure,
  ToolOutput,
  ToolRuntime,
  resolveToolName,
  type ToolCall,
  type ToolDefinition,
  type ToolResultValue,
} from "@novaclaw/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ToolCatalogue } from "../tool-catalogue"
import { ToolPolicyGate } from "../tool-policy-gate"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ExternalToolSource } from "./external-tool-source"
import {
  definition,
  isDeferred,
  outputPreview,
  permission,
  settle,
  sideEffect,
  validateRegistration,
  type AnyTool,
  type Context as ToolContext,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  /** Present for runner-owned execution; absent only when a caller executes a tool without running a model. */
  readonly model?: ToolContext["model"]
  /** Canonical paths of the user's attachments for this turn; forwarded to every tool's Context. */
  readonly attachmentPaths?: ReadonlySet<string>
  /**
   * The assistant turn's remaining image allowance; forwarded to every tool's Context.
   *
   * 🔴 **Declared here because it was NOT, and that silently disconnected the whole mechanism.** The
   * runner has always sent this field, through a conditional SPREAD — and a spread is exempt from
   * excess-property checking, so a field this type never declared typechecked at the call site and
   * was dropped on the floor. `read`'s withholding gate (`tool/read.ts` → `imageBudget`) therefore
   * read `undefined` every time and never fired, for the life of the feature, with every test green.
   */
  readonly imageBudget?: ToolContext["imageBudget"]
  readonly call: ToolCall
  readonly timing?: ToolContext["timing"]
}

export interface Interface {
  /** Every currently registered canonical tool, before per-agent visibility filters. */
  readonly catalogue: () => Effect.Effect<ReadonlyArray<ToolCatalogue.Source>>
  readonly materialize: (
    /** One ruleset, or the LAYERS of `PermissionV2.horizonLayers` — withdrawn when any layer wholly disables. */
    permissions?: PermissionV2.Ruleset | ReadonlyArray<PermissionV2.Ruleset>,
    offered?: (name: string) => boolean,
    discovered?: ReadonlySet<string>,
    /**
     * Which NARROWED variant of a tool this turn should be offered, if any.
     *
     * 🔴 `offered` can only say yes or no to a whole tool. Withholding PART of one — `colleague`'s
     * `ask` at the hop cap, while `list`, `hire` and `retire` stay — needs a third answer, and this
     * is it. The variant names a key in the tool's own `variants`; a tool that declares none is
     * unaffected.
     */
    variantOf?: (name: string) => string | undefined,
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly sideEffects: Readonly<Record<string, import("./tool").SideEffectClass>>
  /** Filtered schemas intentionally absent from `definitions` until discovered. */
  readonly deferred: ReadonlyArray<ToolCatalogue.Source>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
  /**
   * Ephemeral source for the runner's model-aware oversized-output summarizer.
   *
   * The normal `result` / `output` fields above are already bounded and are the ONLY values that
   * may be published into durable history or sent to a provider. This field deliberately exists
   * only on the in-process settlement crossing from the registry to the runner: the registry owns
   * the one bounding seam, while only the runner knows which model and context limit are in force.
   * Outputs above the store's semantic-summary ceiling never enter this field.
   */
  readonly semanticSummarySource?: {
    readonly output: ToolOutput
    readonly artifacts: ReadonlyArray<ToolOutputStore.OutputArtifact>
  }
  /**
   * A pre-action policy returned `halt`: the call did not run AND the drain must stop.
   *
   * ⚠️ Distinct from an ordinary refused call, which is just an error result the model routes
   * around. `session/runner/llm.ts` reads this and breaks the drain loop; `tool-policy.ts` carries
   * why `halt` outranks `deny` in composition.
   */
  readonly halted?: boolean
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ToolRegistry") {}

// The unknown-tool horizon lives in `@novaclaw/llm` — `ToolRuntime.unknownToolMessage`, implemented in
// packages/llm/src/unknown-tool.ts, which carries the full rationale (why naming the tools that DO exist is
// the difference between a dead turn and a recoverable one, and why the empty-registry branch and the
// character budget are both load-bearing).
//
// It used to be defined HERE — it shipped in this file, ported from outside contribution #4
// (@DassaultFalconKing) — and moved down the dependency edge on 2026-07-28 because a second dispatch seam
// (`ToolRuntime.dispatch`) was still handing back a bare `Unknown tool: X`. Two seams answering the same
// question two ways is ruling 6's forbidden shape; `core` depends on `llm` and not the reverse, so `llm` is
// the only end that can hold the shared gate. **Do not re-add a copy here** — the check that keeps that
// sentence true rather than aspirational is `test/tool-registry.test.ts` → "there is exactly ONE
// unknown-tool message".

/**
 * A tool-name list bounded by the SAME character budget the shared unknown-tool message spends, read
 * off `ToolRuntime` so the number cannot drift from the one the resident seam uses. The reason is the
 * shared one: an unbounded list is its own denial of service on a small model's context. A truncated
 * list says so, because a list that silently ends is a second silent omission.
 */
const boundedNameList = (names: ReadonlyArray<string>): string => {
  const shown: Array<string> = []
  let budget = ToolRuntime.UNKNOWN_TOOL_LIST_BUDGET
  for (const candidate of names) {
    budget -= candidate.length + 2
    if (budget < 0 && shown.length > 0) break
    shown.push(candidate)
  }
  return shown.length === names.length
    ? shown.join(", ")
    : `${shown.join(", ")}, and ${names.length - shown.length} more`
}

/** Keyed by the tool VALUE, so a registration never has to carry an extra field. See below. */
const availabilityOf = new WeakMap<AnyTool, Effect.Effect<boolean>>()
const deferredDispatchers = new WeakSet<AnyTool>()

/** Grant one trusted resident tool the per-materialization deferred dispatcher. The capability is
 *  keyed by tool identity so the registry never learns a magic registration name. */
export const withDeferredDispatcher = <T extends AnyTool>(tool: T): T => {
  deferredDispatchers.add(tool)
  return tool
}

/**
 * Declare a live availability predicate for a tool: `materialize` evaluates it when the model's
 * horizon is built, and withdraws the tool for that horizon when it answers `false`.
 *
 * ⚠️ **This is one of THREE horizon filters, and it is deliberately generic — the registry must
 * never learn a tool's name.** `whollyDisabled` below withdraws a tool the permission ruleset wholly
 * denies; the caller's pure routing predicate withdraws model-specific variants. This one withdraws
 * a tool whose OWN module says it is unavailable right
 * now, and the reason it exists is todo.md **ruling 3** (*read every runtime-editable value through
 * to its store at the point of use; a settings change is not a reboot*): a tool that decides its
 * availability from config cannot decide it once, at `Layer.effect` scope, because that answer is
 * frozen until the whole location is torn down. `tool/profile.ts` is the only such tool in the tree
 * and carries the full design argument, including the two options that were rejected.
 *
 * All three filters answer the same question — *is this tool on the horizon* — and answer it in one
 * place, which is what ruling 6 asks for. None advertises-then-refuses: a withdrawn tool is
 * absent from `definitions`, and a call arriving for it from an older horizon is settled by
 * `ToolRuntime.unknownToolMessage`, which names the tools that DO exist.
 *
 * **Cost.** `materialize` runs per turn AND per step (`session/runner/llm.ts`), so a predicate is on
 * a hot path. Only a tool that declares one pays anything — the `WeakMap` lookup for every other
 * tool is a miss and the loop is unchanged — but the declaring module owes a measurement. Measured
 * for the one live predicate (2026-07-31, 28 tools on the horizon): `materialize()` is 0.029 ms/call
 * with no predicate evaluated and 0.570 ms/call with `profile`'s, i.e. one `SELECT` over
 * `runtime_setting`. Numbers and the ceiling live in `test/tool-profile-availability.test.ts`.
 *
 * ⚠️ **Apply this LAST, to the exact value being registered.** It keys on the tool object, and
 * `Tool.withPermission` returns a NEW object carrying a copy of the tool's runtime — so
 * `withAvailability(withPermission(t, "edit"), p)` works and `withPermission(withAvailability(t, p),
 * "edit")` silently loses the predicate. Pinned both ways in `test/tool-profile-availability.test.ts`.
 */
export const withAvailability = <T extends AnyTool>(tool: T, available: Effect.Effect<boolean>): T => {
  availabilityOf.set(tool, available)
  return tool
}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const external = yield* ExternalToolSource.Service
    const resources = yield* ToolOutputStore.Service
    const policies = yield* ToolPolicyGate.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    /**
     * ── THE PRE-ACTION POLICY SEAM ────────────────────────────────────────────────────────────
     *
     * 🔴 HERE, and deliberately in `settleRaw` rather than in `settleWith`. Every tool call reaches
     * this function — core tools, application tools, MCP/plugin tools, AND the deferred dispatcher's
     * nested invocations, which call `settleRaw` directly and would walk past a gate placed one
     * level up. Same argument `project-exclusion.ts` makes for `LocationMutation.resolve`: a guard
     * below all the tools is inherited by a tool added later, and a guard sprinkled per-tool is a
     * checklist somebody eventually forgets. `tool-policy.ts` carries the composition rules.
     *
     * ⚠️ It runs AFTER the stale-registration check, so a policy is never consulted about a call
     * that was never going to run, and BEFORE `settle`, which is the whole point of "pre-action".
     */
    const settleRaw = Effect.fn("ToolRegistry.settleRaw")(function* (
      input: ExecuteInput,
      advertised: object,
      deferredTools: ReadonlyArray<ToolCatalogue.Source>,
      invokeDeferred?: ToolContext["invokeDeferred"],
      halt?: { halted: boolean },
    ) {
      /**
       * 🔴 **THE PRECEDENCE, and it is the same one `catalogue` and `materialize` advertise in:
       * `local` > `application` > `external`.**
       *
       * Application beats external deliberately. An external tool arrives from an MCP server or a
       * plugin — the untrusted end — and letting it win a name collision would let a remote party
       * SHADOW a first-party application tool: the model would be told it is calling the OS's own
       * tool and reach someone else's code instead. Precedence is a trust ordering here, not a
       * registration detail.
       *
       * ⚠️ It is written three times (here, `catalogue`, `materialize`) because each site needs a
       * different shape, and until 2026-08-19 the other two had it BACKWARDS — they looped
       * applications first and let external overwrite. The identity check below then rejected every
       * colliding name: the advertised registration was the external one, the resolved registration
       * was the application one, so the call answered `Stale tool call` **every time** and neither
       * tool was reachable. `registry-source-precedence.test.ts` now asserts all three agree.
       */
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ??
        applications.entries().get(input.call.name) ??
        (yield* external.entries()).get(input.call.name)
      if (!registration || registration.identity !== advertised)
        return yield* new ToolFailure({ message: `Stale tool call: ${input.call.name}` })
      const screened = yield* policies.screen({
        sessionID: input.sessionID,
        agent: input.agent,
        tool: input.call.name,
        toolCallID: input.call.id,
        input: input.call.input,
      })
      if (screened.kind === "refuse") {
        // The halt latch is set on the shared holder rather than carried in the error, because a
        // refusal travels as an ordinary `ToolFailure` — the type every tool absorber already
        // lowers into a model-visible error result — and adding a second failure type here would
        // make every existing `catchTag("LLM.ToolFailure")` in the tree incomplete.
        if (screened.halt && halt) halt.halted = true
        return yield* new ToolFailure({ message: screened.message })
      }
      const output = yield* settle(
        registration.tool,
        screened.input === input.call.input ? input.call : { ...input.call, input: screened.input },
        {
          sessionID: input.sessionID,
          agent: input.agent,
          assistantMessageID: input.assistantMessageID,
          toolCallID: input.call.id,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.timing === undefined ? {} : { timing: input.timing }),
          attachmentPaths: input.attachmentPaths ?? new Set(),
          ...(input.imageBudget === undefined ? {} : { imageBudget: input.imageBudget }),
          ...(deferredTools.length === 0 ? {} : { deferredTools }),
          ...(invokeDeferred === undefined || !deferredDispatchers.has(registration.tool) ? {} : { invokeDeferred }),
        },
      )
      return {
        output: screened.note === undefined ? output : withPolicyNote(output, screened.note),
        tool: registration.tool,
      }
    })

    // `advertised` is the identity materialization handed to the model, and it is always supplied: the only
    // caller resolves the registration first and reports an unadvertised name itself
    // (`ToolRuntime.unknownToolMessage`). Reaching the raw executor with no matching registration therefore
    // means it was removed mid-turn — stale, never unknown.
    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised: object,
      deferredTools: ReadonlyArray<ToolCatalogue.Source>,
      invokeDeferred?: ToolContext["invokeDeferred"],
      halt?: { halted: boolean },
    ) {
      const pending = yield* settleRaw(input, advertised, deferredTools, invokeDeferred, halt).pipe(
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return halt?.halted === true ? { ...pending, halted: true as const } : pending
      const output = pending.output
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        toolCallID: input.call.id,
        output,
        preview: outputPreview(pending.tool),
      })
      const retainedArtifacts = bounded.artifacts ?? []
      // All retained paths describe one output. If any component crosses the model-bypass ceiling,
      // never hand the combined unbounded value to a summarizer under cover of an eligible sibling.
      const semanticArtifacts =
        retainedArtifacts.length > 0 && retainedArtifacts.every((artifact) => artifact.semanticSummary === "eligible")
          ? retainedArtifacts
          : []
      const semanticSummarySource =
        semanticArtifacts.length === 0 ? {} : { semanticSummarySource: { output, artifacts: semanticArtifacts } }
      const result = ToolOutput.toResultValue(bounded.output)
      // A nested deferred invocation can halt while the OUTER tool still returns normally, so the
      // latch is read here too rather than only on the refusal path.
      const halted = halt?.halted === true ? ({ halted: true } as const) : {}
      if (result.type === "error")
        return bounded.outputPaths.length > 0
          ? { result, outputPaths: bounded.outputPaths, ...semanticSummarySource, ...halted }
          : { result, ...halted }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths, ...semanticSummarySource, ...halted }
        : { result, output: bounded.output, ...halted }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        // ⚠️ A PRE-PASS over every entry, and that ordering is load-bearing (todo.md ruling 2 — a
        // failed mutation never reports success): validation completes for the whole batch before the
        // uninterruptible block below touches `local`, so one refused entry takes its siblings with
        // it rather than leaving half a registration behind. Keep any new check here, not in the loop.
        //
        // `validateRegistration` — not `validateName` — because a registration is the only kind of
        // seam that holds the key and the tool together, and therefore the only kind that can see a
        // tool declaring the very name it is being registered under. `Tool.withPermission` runs before
        // the key exists, so it is blind to that no-op by construction; see the note on it in
        // `tool.ts`, which also names the one other registration seam (`ApplicationTools.register`)
        // that still runs the weaker `validateName`.
        yield* Effect.forEach(entries, ([name, tool]) => validateRegistration(name, tool), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      catalogue: Effect.fn("ToolRegistry.catalogue")(function* () {
        const sources = new Map<string, ToolCatalogue.Source>()
        // PRECEDENCE — see `settleRaw`. Lowest first, so a later `set` wins: external < application
        // < local. External comes first here and in `materialize` because these two ADVERTISE and
        // `settleRaw` RESOLVES, and a name that resolves to one tool while being advertised as
        // another can only ever answer `Stale tool call`.
        for (const [name, registration] of yield* external.entries())
          sources.set(name, {
            server: ToolCatalogue.externalServer(name),
            definition: definition(name, registration.tool),
          })
        for (const [name, registration] of applications.entries())
          sources.set(name, { server: "application", definition: definition(name, registration.tool) })
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) sources.set(name, { server: "core", definition: definition(name, registration.tool) })
        }
        return [...sources.values()].toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (
        permissions: PermissionV2.Ruleset | ReadonlyArray<PermissionV2.Ruleset> = [],
        offered = () => true,
        discovered = new Set<string>(),
        variantOf = () => undefined,
      ) {
        type MaterializedRegistration = Registration & { readonly server: string; readonly deferred: boolean }
        const registrations = new Map<string, MaterializedRegistration>()
        // PRECEDENCE — external < application < local, the same order `settleRaw` resolves in and
        // the same order `catalogue` advertises in. See the block comment on `settleRaw`.
        for (const [name, entry] of yield* external.entries())
          registrations.set(name, { ...entry, server: ToolCatalogue.externalServer(name), deferred: true })
        for (const [name, entry] of applications.entries())
          registrations.set(name, { ...entry, server: "application", deferred: false })
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration)
            registrations.set(name, { ...registration, server: "core", deferred: isDeferred(registration.tool) })
        }
        // Three withdrawals, one seam. Permission decides first and permanently removes a denied
        // registration. Routing runs only over survivors, so a `true` route decision can undo an
        // earlier ROUTING decision but can never resurrect a permission-withdrawn tool. Live tool
        // availability runs last, and a routed-off tool never pays its predicate's I/O.
        // One ruleset or several LAYERS (`PermissionV2.horizonLayers`): a tool is withdrawn when any
        // layer wholly disables it, which is how the verdict reads them — see that function.
        const layers: ReadonlyArray<PermissionV2.Ruleset> = isLayered(permissions) ? permissions : [permissions]
        for (const [name, registration] of registrations) {
          if (layers.some((layer) => whollyDisabled(permission(registration.tool, name), layer))) {
            registrations.delete(name)
            continue
          }
          if (!offered(name)) {
            registrations.delete(name)
            continue
          }
          const available = availabilityOf.get(registration.tool)
          if (available !== undefined && !(yield* available)) registrations.delete(name)
        }
        const resident = new Map([...registrations].filter(([, registration]) => !registration.deferred))
        const deferred = [...registrations]
          .filter(([, registration]) => registration.deferred)
          .map(([name, registration]) => ({
            server: registration.server,
            definition: definition(name, registration.tool),
          }))
          .toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
        const deferredByName = new Map(
          deferred.map((source) => [source.definition.name, registrations.get(source.definition.name)!]),
        )
        const callableDeferred = new Map([...deferredByName].filter(([name]) => discovered.has(name)))
        const callableNames = [...resident.keys(), ...callableDeferred.keys()]
        const residentNames = [...resident.keys()]
        const callableDeferredNames = [...callableDeferred.keys()]
        const installedDeferredNames = [...deferredByName.keys()]
        return {
          // ⚠️ NOT SORTED, deliberately — see NC-PROMPT-CACHE-006. Sorting these would stabilise the
          // prefix (definitions render AHEAD of the system prompt, so an unstable order invalidates
          // everything after them), but it also changes THE ORDER THE MODEL SEES ITS TOOLS, and tool
          // choice is sensitive to that on the small models this product targets. That is a behaviour
          // change and needs an A/B against a model, not a tidy-up. `deferred` above is sorted because
          // it is a discovery list, not the callable array.
          definitions: Array.from(resident, ([name, registration]) =>
            definition(name, registration.tool, variantOf(name)),
          ),
          sideEffects: Object.fromEntries(
            [...resident, ...callableDeferred].map(([name, registration]) => [name, sideEffect(registration.tool)]),
          ),
          deferred,
          settle: (input) => {
            const registration = resident.get(input.call.name) ?? callableDeferred.get(input.call.name)
            // One latch per model tool call, closed over by both the outer settlement and every
            // nested deferred invocation it makes. A halt raised while `tool_call` dispatches an
            // inner tool therefore still reaches the drain, instead of being flattened into the
            // dispatcher's own error result.
            const halt = { halted: false }
            /**
             * 🔴 **The name here was typed by the MODEL, so this seam must tolerate an imperfect one.**
             *
             * It was an exact `Map` lookup whose miss said "not callable in this session — call
             * tool_search and use an exact name it returned", which hands a model that mistyped one
             * character an instruction to repeat the search that produced the name it just mistyped.
             * The harness manufactures that imperfection too: three of our own deferred tools are
             * hyphenated in an otherwise snake_case tree, so a model that has only ever seen
             * `apply_patch` and `tool_search` writes `read_hex` for `read-hex` as a near certainty.
             *
             * Renaming them was the other candidate fix and is NOT safe: a registered name is also
             * the permission ACTION a rule resolves against (`Tool.permission` falls back to it), and
             * those rules are authored by users and persisted, so a rename silently turns a stored
             * `deny register-app` into no rule at all. Recovery here is also the more general answer —
             * it covers every future typo rather than three known names.
             *
             * Resolution order matters. Exact wins over near, and deferred over resident, because
             * `resident`/`callableDeferred` partition one registration map: a name in one is never in
             * the other, and a LOOSE match must never outrank an EXACT one. `resolveToolName` is the
             * same whitelist-gated canonicalizer the provider seam spends on resident calls
             * (`protocols/openai-chat.ts`), so it can only ever return a name already callable here —
             * it cannot invent one. When nothing resolves, the answer still distinguishes installed
             * from unknown and carries the near-miss clause the resident seam has always had.
             */
            const invokeDeferred: NonNullable<ToolContext["invokeDeferred"]> = (name, targetInput) => {
              const callDirectly = (native: string) =>
                Effect.fail(
                  new ToolFailure({
                    message:
                      `${native} is a resident provider-native tool already advertised in this turn. ` +
                      `Call ${native} directly as the tool name; do not use tool_call or tool_search for resident tools.`,
                  }),
                )
              if (resident.has(name)) return callDirectly(name)
              const resolved = callableDeferred.has(name) ? name : resolveToolName(name, callableDeferredNames)
              const target = resolved === undefined ? undefined : callableDeferred.get(resolved)
              if (target === undefined || resolved === undefined) {
                const nearResident = resolveToolName(name, residentNames)
                if (nearResident !== undefined) return callDirectly(nearResident)
                // Installed-but-undisclosed is a different answer from does-not-exist — the outer
                // settlement below already draws that line, and a near miss has to reach it too or a
                // one-character slip is told the tool does not exist at all.
                const installed = resolveToolName(name, installedDeferredNames)
                if (installed !== undefined)
                  return Effect.fail(
                    new ToolFailure({
                      message:
                        `Deferred tool ${installed} is installed but its schema has not been disclosed in this session. ` +
                        `Nothing ran. Call tool_search for the capability you need, then invoke the exact name it returns.`,
                    }),
                  )
                const hint = ToolRuntime.closestToolName(name, callableDeferredNames)
                // Both branches are load-bearing, exactly as in the shared unknown-tool message: an
                // empty list is not a horizon, and a dangling "callable here: ." would be a fault
                // described falsely. Naming the set this dispatcher can actually reach is what turns
                // a dead turn into a recoverable one.
                const available =
                  callableDeferredNames.length === 0
                    ? "No deferred tool has been disclosed in this session yet."
                    : `Disclosed and callable through tool_call here: ${boundedNameList(callableDeferredNames)}.`
                return Effect.fail(
                  new ToolFailure({
                    message:
                      `Deferred tool ${name} is not callable in this session. Nothing ran. ` +
                      (hint === undefined ? "" : `Did you mean "${hint}"? `) +
                      `${available} Call tool_search for any other capability and use an exact name it returns.`,
                  }),
                )
              }
              // The RESOLVED name travels on, so the permission gate, the policy screen and the
              // durable record all see the tool that actually ran rather than what was typed.
              return settleRaw(
                { ...input, call: { type: "tool-call", id: input.call.id, name: resolved, input: targetInput } },
                target.identity,
                deferred,
                undefined,
                halt,
              ).pipe(Effect.map((settled) => settled.output))
            }
            if (registration) return settleWith(input, registration.identity, deferred, invokeDeferred, halt)
            if (deferredByName.has(input.call.name))
              return Effect.succeed({
                result: {
                  type: "error",
                  value:
                    `Tool ${input.call.name} is installed but its schema has not been disclosed in this session. ` +
                    `Nothing ran. Call tool_search for the capability you need, then invoke an exact returned name through tool_call.`,
                },
              })
            return Effect.succeed({
              result: { type: "error", value: ToolRuntime.unknownToolMessage(input.call.name, callableNames) },
            })
          },
        }
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

/**
 * Put a policy's sentence in front of the tool's own result.
 *
 * 🔴 The MODEL half of "bind every intervention to a receipt". The durable half is
 * `session_policy_decision`; this is the half that stops the model from being lied to — a rewritten
 * `bash` command whose output does not match what the model typed is otherwise indistinguishable
 * from a broken tool, and the model will spend the rest of the turn debugging the wrong thing.
 *
 * ⚠️ The empty-`content` branch is not cosmetic. `ToolOutput.toResultValue` prefers `content` when
 * it is non-empty, so appending a note to a structured-only output would replace the structured
 * value the model was supposed to receive with the note alone. Serialising `structured` alongside
 * keeps the result complete; `structured` itself is untouched, so the durable record and the UI see
 * exactly what the tool returned.
 */
function withPolicyNote(output: ToolOutput, note: string): ToolOutput {
  const text = { type: "text" as const, text: note }
  if (output.content.length === 0)
    return {
      structured: output.structured,
      content: [text, { type: "text" as const, text: stringifyStructured(output.structured) }],
    }
  return { structured: output.structured, content: [text, ...output.content] }
}

function stringifyStructured(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Is this tool withdrawn from the model's HORIZON entirely, rather than merely refused on use?
 *
 * ⚠️ Exported for a ledger, not for callers: `plugin/agent.ts` composes floors whose deny arms are
 * meant to take a tool off the horizon, and that intent is invisible in the rule itself — a deny on
 * `resource: "*"` withdraws while a deny on a NARROWER resource does not. Stating that in a comment
 * beside the floor got it wrong once already; `agent-floor-horizon.test.ts` drives this instead.
 */
const isLayered = (
  permissions: PermissionV2.Ruleset | ReadonlyArray<PermissionV2.Ruleset>,
): permissions is ReadonlyArray<PermissionV2.Ruleset> => permissions.length > 0 && Array.isArray(permissions[0])

export function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ExternalToolSource.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ExternalToolSource.node, ToolOutputStore.node, ToolPolicyGate.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ExternalToolSource.node, ToolOutputStore.node, ToolPolicyGate.node],
})
